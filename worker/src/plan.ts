/**
 * The free trial and the team plan, as rules with no imports, so the tests
 * can load them in plain Node (billing.ts does the money).
 */

export const PLAN_CENTS = 7900;
export const PLAN_SECS = 250 * 60;
export const TRIAL_SECS = 30 * 60;

/** What the rules read off an org row. */
interface Allowance {
  credit_cents: number;
  trial_ends_at: number;
  plan_status: string;
  plan_period_end: number;
  included_secs_used: number;
}

/** Billing is off without a Stripe key, so `wrangler dev` stays usable. */
const metered = (env: { STRIPE_SECRET_KEY?: string }): boolean => Boolean(env.STRIPE_SECRET_KEY);

const LIVE = new Set(["active", "trialing", "past_due"]);
export const planActive = (org: Allowance, now = Date.now()): boolean =>
  LIVE.has(org.plan_status) && org.plan_period_end > now;
export const trialActive = (org: Allowance, now = Date.now()): boolean =>
  !planActive(org, now) && org.trial_ends_at > now;

/** Included call seconds left: the plan's this period, else the trial's. */
export function includedLeft(org: Allowance, now = Date.now()): number {
  if (planActive(org, now)) return Math.max(0, PLAN_SECS - org.included_secs_used);
  if (trialActive(org, now)) return Math.max(0, TRIAL_SECS - org.included_secs_used);
  return 0;
}

/** Whether this org may place or take a call right now. On the plan, always:
 *  minutes past the included ones are invoiced, not blocked. */
export const entitled = (env: { STRIPE_SECRET_KEY?: string }, org: Allowance): boolean =>
  !metered(env) || planActive(org) || includedLeft(org) > 0 || org.credit_cents > 0;

/** Whether its WhatsApp messages are answered: chats are unlimited on the
 *  plan and in the trial, and never metered. */
export const chatAllowed = (env: { STRIPE_SECRET_KEY?: string }, org: Allowance): boolean =>
  !metered(env) || planActive(org) || trialActive(org) || org.credit_cents > 0;
