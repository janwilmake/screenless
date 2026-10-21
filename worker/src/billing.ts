/**
 * The free trial, the team plan, and credit, per organization (session 16).
 *
 * A new team gets 14 days free with 2 hours of calls. The team plan is $200 a
 * month, the founding price: unlimited WhatsApp chats and 40 hours of calls
 * and meetings, then 15¢ a minute,
 * which Stripe adds to the next invoice, so a paying team is never cut off
 * mid-month. WhatsApp chats cost us a fraction of a cent (the work runs on
 * the member's own Claude subscription), so they are never metered. Credit
 * (`orgs.credit_cents`, topped up through a one-time Checkout) still pays for
 * call minutes outside a plan or trial: the balances of teams from before the
 * plan keep working.
 *
 * The plan's period is what Stripe says it is, read from the subscription:
 * at checkout, on its webhooks, and again whenever the period on file has
 * ended, so a missing webhook cannot leave a team blocked or unbilled.
 *
 * Two paths record a topup, deliberately:
 *   1. The webhook, the moment Stripe confirms payment.
 *   2. `reconcilePending()`, polled while the billing page is waiting — which
 *      also carries the whole flow if the webhook is misconfigured. Both write
 *      the same ledger id, so whichever lands second changes nothing.
 */

import type { Env } from "./index";
import * as db from "./db";

const STRIPE_API = "https://api.stripe.com/v1";

/** Topup sizes offered on the billing tab, in cents. */
export const TOPUP_OPTIONS = [1000, 2500, 10000];

/**
 * Billing is off until a key is present, which keeps `wrangler dev` and any
 * pre-Stripe deploy fully usable. It fails open by omission, never by error:
 * an unconfigured paywall that 500s on every call is worse than no paywall.
 */
export const billingEnabled = (env: Env): boolean => Boolean(env.STRIPE_SECRET_KEY);

export { PLAN_CENTS, PLAN_SECS, TRIAL_SECS, planActive, trialActive, includedLeft, entitled, chatAllowed } from "./plan";
import { PLAN_CENTS, PLAN_SECS, TRIAL_SECS, planActive, trialActive, includedLeft } from "./plan";

/** Where a team stands, for the billing tab and `screenless billing`. */
export function standing(env: Env, org: db.Org) {
  const now = Date.now();
  const kind = planActive(org, now) ? "plan" : trialActive(org, now) ? "trial" : org.credit_cents > 0 ? "credit" : "none";
  return {
    kind,
    trialEndsAt: org.trial_ends_at,
    includedSecs: kind === "plan" ? PLAN_SECS : kind === "trial" ? TRIAL_SECS : 0,
    includedUsedSecs: kind === "plan" || kind === "trial" ? org.included_secs_used : 0,
    periodEnd: org.plan_period_end,
    cancelAtEnd: Boolean(org.plan_cancel_at_end),
    planStatus: org.plan_status,
    creditCents: org.credit_cents,
    planCents: PLAN_CENTS,
    planSecs: PLAN_SECS,
    priceCentsPerMinute: db.priceCentsPerMinute(env),
  };
}

/**
 * Charges a finished call: included seconds first (the plan's or the
 * trial's), the rest at the per-minute price. On the plan, Stripe invoices
 * the rest with the next month; otherwise it comes off the credit. A trial's
 * last call that runs past its 30 minutes, with no credit, is on us.
 */
export async function chargeCall(env: Env, org: db.Org, userId: string | null, callId: string, seconds: number): Promise<void> {
  const left = includedLeft(org);
  const included = Math.min(seconds, left);
  const extra = seconds - included;
  const cents = Math.ceil((extra * db.priceCentsPerMinute(env)) / 60);
  const onPlan = planActive(org);
  if (onPlan && cents > 0 && org.stripe_customer_id && billingEnabled(env)) {
    await stripe(env, "/invoiceitems", {
      customer: org.stripe_customer_id,
      currency: "usd",
      amount: cents,
      description: `Call minutes beyond the plan: ${Math.ceil(extra / 60)} min`,
      ...(org.stripe_subscription_id ? { subscription: org.stripe_subscription_id } : {}),
    }, `overage-${callId}`).catch((err) => console.error("overage invoice item failed", callId, (err as Error).message));
  }
  const chargeCredit = !onPlan && (trialActive(org) ? org.credit_cents > 0 : true);
  await db.debitCall(env, org.id, userId, callId, seconds, chargeCredit || onPlan ? cents : 0, included, chargeCredit);
}

/* ------------------------------------------------------------ stripe glue */

export class StripeError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, message: string) {
    super(message);
    this.status = status;
    this.path = path;
    this.name = "StripeError";
  }
}

/**
 * Stripe's API is form-encoded, including its nested structures, which arrive
 * as `metadata[orgId]`. Flatten rather than hand-write the bracket paths at
 * every call site.
 */
function form(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(...form(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function stripe<T>(
  env: Env,
  path: string,
  params?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: params ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: params ? form(params).join("&") : undefined,
  });

  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new StripeError(res.status, path, body.error?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

/* ----------------------------------------------------------------- topups */

interface CheckoutSession {
  id: string;
  url?: string;
  status?: string;
  payment_status?: string;
  customer?: string | { id: string };
  amount_total?: number;
  metadata?: Record<string, string>;
}

const idOf = (v: string | { id: string } | undefined | null): string | undefined =>
  typeof v === "string" ? v : v?.id;

/** Stash key remembering the Checkout Session the billing page is polling on. */
const pendingKey = (orgId: string) => `topup:${orgId}`;

export async function createTopup(
  env: Env,
  org: db.Org,
  user: db.User,
  amountCents: number,
): Promise<{ url: string }> {
  if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 100000)
    throw new StripeError(400, "/checkout/sessions", "topup must be between $5 and $1000");

  const site = env.SITE_URL || "https://screenless.sh";
  const session = await stripe<CheckoutSession>(env, "/checkout/sessions", {
    mode: "payment",
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: { name: "screenless credit", description: "Pay-as-you-go call credit" },
        },
      },
    },
    // Everything needed to credit the right org travels in metadata and comes
    // back on the webhook; nothing is inferred from the payer.
    metadata: { kind: "topup", orgId: org.id, userId: user.id, amountCents: String(amountCents) },
    ...(org.stripe_customer_id
      ? { customer: org.stripe_customer_id }
      : { customer_creation: "always", ...(user.email ? { customer_email: user.email } : {}) }),
    success_url: `${site}/team?topup=done`,
    cancel_url: `${site}/team`,
  });

  if (!session.url) throw new StripeError(502, "/checkout/sessions", "no checkout url returned");
  await db.stashPut(env, pendingKey(org.id), session.id, 3600);
  return { url: session.url };
}

/** Applies a paid Checkout Session exactly once, whoever reports it first. */
async function applyTopup(env: Env, session: CheckoutSession): Promise<void> {
  const meta = session.metadata ?? {};
  if (meta.kind !== "topup" || !meta.orgId) return;
  if (session.payment_status !== "paid") return;

  const cents = session.amount_total ?? parseInt(meta.amountCents || "0", 10);
  if (!cents) return;

  await db.credit(env, meta.orgId, cents, "topup", `stripe ${session.id}`, `topup:${session.id}`, meta.userId);
  const customerId = idOf(session.customer);
  if (customerId) await db.setStripeCustomer(env, meta.orgId, customerId);
}

/**
 * Polled by the billing page after Checkout: reads the pending session straight
 * from Stripe so the balance updates even if the webhook never arrives.
 */
export async function reconcilePending(env: Env, orgId: string): Promise<boolean> {
  const sessionId = await db.stashGet(env, pendingKey(orgId));
  if (!sessionId) return false;
  try {
    const session = await stripe<CheckoutSession & { mode?: string; subscription?: string }>(env, `/checkout/sessions/${sessionId}`);
    if (session.mode === "subscription") {
      if (session.status !== "complete") return false;
      await applyPlanSession(env, session);
      await db.stashDelete(env, pendingKey(orgId));
      return true;
    }
    if (session.payment_status !== "paid") return false;
    await applyTopup(env, session);
    await db.stashDelete(env, pendingKey(orgId));
    return true;
  } catch (err) {
    console.error("stripe reconcile failed", (err as Error).message);
    return false;
  }
}

/* ------------------------------------------------------------- the plan */

interface Subscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean;
  customer?: string | { id: string };
  metadata?: Record<string, string>;
  current_period_start?: number;
  current_period_end?: number;
  items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
}

/** Starts the team plan through Stripe Checkout. */
export async function createPlanCheckout(env: Env, org: db.Org, user: db.User): Promise<{ url: string }> {
  const site = env.SITE_URL || "https://screenless.sh";
  const session = await stripe<CheckoutSession>(env, "/checkout/sessions", {
    mode: "subscription",
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: PLAN_CENTS,
          recurring: { interval: "month" },
          product_data: {
            name: "screenless team plan",
            description: `Founding price, locked for 12 months. Unlimited WhatsApp chats and ${PLAN_SECS / 3600} hours of calls and meetings a month; then ${db.priceCentsPerMinute(env)}¢ a minute`,
          },
        },
      },
    },
    metadata: { kind: "plan", orgId: org.id, userId: user.id },
    subscription_data: { metadata: { orgId: org.id } },
    ...(org.stripe_customer_id
      ? { customer: org.stripe_customer_id }
      : user.email
        ? { customer_email: user.email }
        : {}),
    success_url: `${site}/team?plan=done`,
    cancel_url: `${site}/team`,
  });
  if (!session.url) throw new StripeError(502, "/checkout/sessions", "no checkout url returned");
  await db.stashPut(env, pendingKey(org.id), session.id, 3600);
  return { url: session.url };
}

/** Writes a subscription's state onto its org. Newer Stripe API versions
 *  keep the period on the subscription's items, older ones on itself. */
async function syncSubscription(env: Env, sub: Subscription, orgId?: string): Promise<void> {
  const org = orgId ? await db.orgById(env, orgId) : sub.metadata?.orgId ? await db.orgById(env, sub.metadata.orgId) : await db.orgBySubscription(env, sub.id);
  if (!org) return;
  const item = sub.items?.data?.[0];
  const start = (sub.current_period_start ?? item?.current_period_start ?? 0) * 1000;
  const end = (sub.current_period_end ?? item?.current_period_end ?? 0) * 1000;
  await db.setPlan(env, org.id, {
    status: sub.status,
    periodStart: start,
    periodEnd: end,
    cancelAtEnd: !!sub.cancel_at_period_end,
    subscriptionId: sub.id,
  });
  const customerId = idOf(sub.customer);
  if (customerId) await db.setStripeCustomer(env, org.id, customerId);
}

/** Reads the plan back from Stripe when the period on file is over (or
 *  `force`): renewals and cancellations show up without a webhook. */
export async function refreshPlan(env: Env, org: db.Org, force = false): Promise<db.Org> {
  if (!billingEnabled(env) || !org.stripe_subscription_id) return org;
  if (!force && org.plan_period_end > Date.now()) return org;
  try {
    await syncSubscription(env, await stripe<Subscription>(env, `/subscriptions/${org.stripe_subscription_id}`), org.id);
    return (await db.orgById(env, org.id)) ?? org;
  } catch (err) {
    console.error("stripe plan refresh failed", org.id, (err as Error).message);
    return org;
  }
}

/** Cancels at the end of the period, or takes that back. */
export async function setPlanCancel(env: Env, org: db.Org, cancel: boolean): Promise<void> {
  if (!org.stripe_subscription_id) throw new StripeError(400, "/subscriptions", "no plan to change");
  const sub = await stripe<Subscription>(env, `/subscriptions/${org.stripe_subscription_id}`, { cancel_at_period_end: cancel ? "true" : "false" });
  await syncSubscription(env, sub, org.id);
}

/** A completed plan Checkout: the subscription it created, onto the org. */
async function applyPlanSession(env: Env, session: CheckoutSession & { mode?: string; subscription?: string | { id: string } }): Promise<void> {
  const meta = session.metadata ?? {};
  if (meta.kind !== "plan" || !meta.orgId) return;
  const subId = idOf(session.subscription);
  if (!subId) return;
  await syncSubscription(env, await stripe<Subscription>(env, `/subscriptions/${subId}`), meta.orgId);
}

/* ----------------------------------------------------------------- webhook */

const enc = new TextEncoder();

/**
 * Verifies Stripe's `t=<ts>,v1=<hmac>` signature over `${ts}.${body}`.
 *
 * The timestamp check is not ceremony: without it a signed body stays valid
 * forever, and a single captured payment event could be replayed at will —
 * harmless here only because the ledger id makes crediting idempotent, but
 * cheap to keep correct.
 */
async function verifySignature(
  body: string,
  header: string,
  secret: string,
  toleranceSecs = 300,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSecs) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Stripe may send several v1 signatures during a secret rotation.
  const provided = header
    .split(",")
    .filter((p) => p.trim().startsWith("v1="))
    .map((p) => p.trim().slice(3));

  let ok = false;
  for (const sig of provided) {
    if (sig.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff === 0) ok = true;
  }
  return ok;
}

export async function handleWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: "billing webhook not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.text();
  const signature = req.headers.get("Stripe-Signature") ?? "";
  if (!(await verifySignature(body, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response(JSON.stringify({ error: "bad signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const event = JSON.parse(body) as {
    type: string;
    data: { object: Record<string, unknown> };
  };

  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object as unknown as CheckoutSession & { mode?: string; subscription?: string };
      if (session.mode === "subscription") await applyPlanSession(env, session);
      else await applyTopup(env, session);
    }
    // The plan's renewals, failures and cancellations, when the endpoint
    // subscribes to them; refreshPlan covers it when it does not.
    if (event.type.startsWith("customer.subscription.")) {
      await syncSubscription(env, event.data.object as unknown as Subscription);
    }
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want for a transient failure.
    console.error("stripe webhook failed", event.type, (err as Error).message);
    return new Response(JSON.stringify({ error: "handler failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
