/**
 * Pay-as-you-go, per organization.
 *
 * Every org starts with ~$10 of credit (the free plan) and calls draw it down
 * by the minute at roughly double our cost. When it runs out, calls stop until
 * an admin tops up — a one-time Stripe Checkout payment, no subscription, no
 * trial clock. The org's balance lives in D1 (`orgs.credit_cents`) with a
 * ledger row per movement; Stripe only ever hears about topups.
 *
 * This replaced the $99/month subscription while Stripe was still in test
 * mode, so there were no live subscribers to migrate.
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

/** Whether this org may place or take a call right now. */
export const entitled = (env: Env, org: db.Org): boolean =>
  !billingEnabled(env) || org.credit_cents > 0;

/* ------------------------------------------------------------ stripe glue */

export class StripeError extends Error {
  constructor(readonly status: number, readonly path: string, message: string) {
    super(message);
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
): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: params ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
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
    const session = await stripe<CheckoutSession>(env, `/checkout/sessions/${sessionId}`);
    if (session.payment_status !== "paid") return false;
    await applyTopup(env, session);
    await db.stashDelete(env, pendingKey(orgId));
    return true;
  } catch (err) {
    console.error("stripe reconcile failed", (err as Error).message);
    return false;
  }
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
      await applyTopup(env, event.data.object as unknown as CheckoutSession);
    }
    // Subscription lifecycle events from the old model may still arrive while
    // the Stripe endpoint subscribes to them; they are simply no longer state.
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
