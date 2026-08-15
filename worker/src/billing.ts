/**
 * Subscription gating: a 7-day free trial, then $99/month, card required up
 * front.
 *
 * The subscriber's identity is the verified phone number — the same key
 * everything else in this API is scoped to. Stripe never sees a user id
 * because there isn't one; the phone travels as subscription metadata and
 * comes back on every lifecycle event.
 *
 * Two paths keep a subscription record fresh, deliberately:
 *
 *   1. The webhook, which is the only thing that hears about a cancellation,
 *      a failed renewal, or a trial ending three days from now.
 *   2. A direct read of the Checkout Session in `status()`, used while the
 *      CLI is polling right after payment. The webhook usually wins that race,
 *      but "usually" is not good enough when the user is watching a spinner,
 *      and this path also carries the flow entirely on its own if the webhook
 *      is misconfigured — which, on a paywall, is the failure you notice last.
 */

import type { Env } from "./index";

const STRIPE_API = "https://api.stripe.com/v1";

/** Statuses that entitle the holder to place calls. A trial is a paid state. */
const ENTITLED = new Set(["trialing", "active"]);

/** Free trial length. Card is collected up front regardless. */
const TRIAL_DAYS = 7;

/** Fallback pricing, used when STRIPE_PRICE_ID is unset. Amount is in cents. */
const FALLBACK_PRICE = { currency: "usd", unitAmount: 9900, interval: "month" };

export interface Subscription {
  status: string;
  customerId?: string;
  subscriptionId?: string;
  /** Seconds since epoch; the moment the card is first charged. */
  trialEnd?: number;
  currentPeriodEnd?: number;
  /** Set when the user has cancelled but the paid period has not run out. */
  cancelAtPeriodEnd?: boolean;
  updatedAt: number;
}

export interface BillingStatus {
  active: boolean;
  status: string;
  trialEnd?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
}

/**
 * Billing is off until a key is present, which keeps `wrangler dev` and any
 * pre-Stripe deploy fully usable. It fails open by omission, never by error:
 * an unconfigured paywall that 500s on every call is worse than no paywall.
 */
export const billingEnabled = (env: Env): boolean => Boolean(env.STRIPE_SECRET_KEY);

export const isEntitled = (sub: Subscription | null): boolean =>
  Boolean(sub && ENTITLED.has(sub.status));

/* ------------------------------------------------------------ stripe glue */

export class StripeError extends Error {
  constructor(readonly status: number, readonly path: string, message: string) {
    super(message);
    this.name = "StripeError";
  }
}

/**
 * Stripe's API is form-encoded, including its nested structures, which arrive
 * as `subscription_data[metadata][phone]`. Flatten rather than hand-write the
 * bracket paths at every call site.
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

/* ------------------------------------------------------------------ store */

const subKey = (phone: string) => `sub:${phone}`;
/** Records the Checkout Session the CLI is currently waiting on. */
const pendingKey = (phone: string) => `pending:${phone}`;

export async function load(env: Env, phone: string): Promise<Subscription | null> {
  const raw = await env.CALLS.get(subKey(phone));
  return raw ? (JSON.parse(raw) as Subscription) : null;
}

async function save(env: Env, phone: string, sub: Subscription): Promise<void> {
  // No TTL. A lapsed subscription record is the thing that tells us this phone
  // has been here before, which matters for not handing out a second trial.
  await env.CALLS.put(subKey(phone), JSON.stringify(sub));
}

/* ---------------------------------------------------------------- checkout */

interface CheckoutSession {
  id: string;
  url?: string;
  status?: string;
  subscription?: string | { id: string };
  customer?: string | { id: string };
}

interface StripeSubscription {
  id: string;
  status: string;
  customer: string | { id: string };
  trial_end?: number | null;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
}

/**
 * Creates a Checkout Session for this phone number and remembers it, so the
 * poll in `status()` has something to reconcile against.
 *
 * Trial eligibility is decided here rather than in Stripe: a number that has
 * held a subscription before goes straight to a charge. Stripe has no notion
 * of "this phone already had its week" — only of customers, and a returning
 * user arrives at Checkout as a brand new one.
 */
export async function createCheckout(
  env: Env,
  phone: string,
  origin: string,
): Promise<{ url: string; sessionId: string }> {
  const site = env.SITE_URL || "https://screenless.sh";
  const previous = await load(env, phone);
  const trialUsed = Boolean(previous?.subscriptionId);

  const lineItem = env.STRIPE_PRICE_ID
    ? { price: env.STRIPE_PRICE_ID, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: FALLBACK_PRICE.currency,
          unit_amount: FALLBACK_PRICE.unitAmount,
          recurring: { interval: FALLBACK_PRICE.interval },
          product_data: { name: "screenless" },
        },
      };

  const session = await stripe<CheckoutSession>(env, "/checkout/sessions", {
    mode: "subscription",
    line_items: { 0: lineItem },
    // The card is taken during the trial, not after it. This is the whole
    // point of "credit card required": it filters for intent, and it means
    // day 8 is a charge rather than a dunning email.
    payment_method_collection: "always",
    subscription_data: {
      ...(trialUsed ? {} : { trial_period_days: TRIAL_DAYS }),
      // Carried on every subsequent lifecycle event, which is how a
      // `customer.subscription.deleted` months from now still finds its phone.
      metadata: { phone },
    },
    metadata: { phone },
    // Stripe rejects "+" here, and this field is only ever used for eyeballing
    // sessions in the dashboard. The authoritative copy is in metadata.
    client_reference_id: phone.replace(/\D/g, ""),
    allow_promotion_codes: true,
    success_url: `${site}/paid`,
    cancel_url: `${site}/#price`,
    ...(previous?.customerId ? { customer: previous.customerId } : {}),
  });

  if (!session.url) throw new StripeError(502, "/checkout/sessions", "no checkout url returned");

  // One hour is far longer than anyone stares at a payment page, and the key
  // is only a reconciliation hint — losing it costs a webhook round trip.
  await env.CALLS.put(pendingKey(phone), session.id, { expirationTtl: 3600 });
  void origin;

  return { url: session.url, sessionId: session.id };
}

/** A Stripe-hosted page for changing the card, or cancelling. */
export async function createPortal(env: Env, phone: string): Promise<string | null> {
  const sub = await load(env, phone);
  if (!sub?.customerId) return null;

  const session = await stripe<{ url: string }>(env, "/billing_portal/sessions", {
    customer: sub.customerId,
    return_url: env.SITE_URL || "https://screenless.sh",
  });
  return session.url;
}

/* ------------------------------------------------------------------ status */

const idOf = (v: string | { id: string } | undefined | null): string | undefined =>
  typeof v === "string" ? v : v?.id;

function record(sub: StripeSubscription): Subscription {
  return {
    status: sub.status,
    customerId: idOf(sub.customer),
    subscriptionId: sub.id,
    trialEnd: sub.trial_end ?? undefined,
    currentPeriodEnd: sub.current_period_end ?? undefined,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    updatedAt: Date.now(),
  };
}

/**
 * Current entitlement for a phone number, reconciling against Stripe if a
 * Checkout Session is still outstanding.
 */
export async function status(env: Env, phone: string): Promise<BillingStatus> {
  if (!billingEnabled(env)) {
    return { active: true, status: "unmetered" };
  }

  let sub = await load(env, phone);

  if (!isEntitled(sub)) {
    const reconciled = await reconcilePending(env, phone);
    if (reconciled) sub = reconciled;
  }

  return {
    active: isEntitled(sub),
    status: sub?.status ?? "none",
    trialEnd: sub?.trialEnd,
    currentPeriodEnd: sub?.currentPeriodEnd,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd,
  };
}

/**
 * Turns a completed Checkout Session into a subscription record without
 * waiting for the webhook. Best-effort by design: any failure here just means
 * the caller stays unentitled for another poll.
 */
async function reconcilePending(env: Env, phone: string): Promise<Subscription | null> {
  const sessionId = await env.CALLS.get(pendingKey(phone));
  if (!sessionId) return null;

  try {
    const session = await stripe<CheckoutSession>(env, `/checkout/sessions/${sessionId}`);
    const subscriptionId = idOf(session.subscription);
    if (session.status !== "complete" || !subscriptionId) return null;

    const sub = await stripe<StripeSubscription>(env, `/subscriptions/${subscriptionId}`);
    const rec = record(sub);
    await save(env, phone, rec);
    await env.CALLS.delete(pendingKey(phone));
    return rec;
  } catch (err) {
    console.error("stripe reconcile failed", (err as Error).message);
    return null;
  }
}

/* ----------------------------------------------------------------- webhook */

const enc = new TextEncoder();

/**
 * Verifies Stripe's `t=<ts>,v1=<hmac>` signature over `${ts}.${body}`.
 *
 * The timestamp check is not ceremony: without it a signed body stays valid
 * forever, and a single captured `subscription.created` could be replayed to
 * re-entitle a cancelled number.
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

/**
 * Applies a Stripe lifecycle event to the stored record.
 *
 * Everything routes through subscription metadata, so an event that has lost
 * its phone is dropped rather than guessed at — writing an entitlement to the
 * wrong number is worse than missing one.
 */
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
  const object = event.data.object;

  try {
    if (event.type === "checkout.session.completed") {
      const phone = (object.metadata as Record<string, string> | undefined)?.phone;
      const subscriptionId = idOf(object.subscription as string | { id: string });
      if (phone && subscriptionId) {
        const sub = await stripe<StripeSubscription>(env, `/subscriptions/${subscriptionId}`);
        await save(env, phone, record(sub));
        await env.CALLS.delete(pendingKey(phone));
      }
    } else if (event.type.startsWith("customer.subscription.")) {
      const sub = object as unknown as StripeSubscription;
      const phone = sub.metadata?.phone;
      if (phone) {
        // `deleted` arrives with whatever status the subscription ended on,
        // which is not always a non-entitling one. Pin it.
        const rec = record(sub);
        if (event.type === "customer.subscription.deleted") rec.status = "canceled";
        await save(env, phone, rec);
      }
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
