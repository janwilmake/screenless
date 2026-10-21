import { test } from "node:test";
import assert from "node:assert/strict";
import { includedLeft, planActive, trialActive, entitled, chatAllowed, PLAN_SECS, TRIAL_SECS } from "../src/plan.ts";

const now = Date.now();
const env = { STRIPE_SECRET_KEY: "sk_test" } as never;
const org = (o: Record<string, unknown>) =>
  ({ credit_cents: 0, trial_ends_at: 0, plan_status: "", plan_period_end: 0, included_secs_used: 0, ...o }) as never;

test("a new team's trial: 2 hours of calls and unlimited chats, for 14 days", () => {
  const t = org({ trial_ends_at: now + 86400_000 });
  assert.equal(trialActive(t), true);
  assert.equal(includedLeft(t), TRIAL_SECS);
  assert.equal(entitled(env, t), true);
  const spent = org({ trial_ends_at: now + 86400_000, included_secs_used: TRIAL_SECS });
  assert.equal(entitled(env, spent), false, "no calls once the 2 hours are used");
  assert.equal(chatAllowed(env, spent), true, "chats go on");
});

test("after the trial, nothing without a plan or credit", () => {
  const ended = org({ trial_ends_at: now - 1000 });
  assert.equal(entitled(env, ended), false);
  assert.equal(chatAllowed(env, ended), false);
  assert.equal(entitled(env, org({ trial_ends_at: now - 1000, credit_cents: 500 })), true, "old credit still pays");
});

test("on the plan: 40 hours, and calls never stop when they run out", () => {
  const p = org({ plan_status: "active", plan_period_end: now + 86400_000, included_secs_used: 100 * 60 });
  assert.equal(planActive(p), true);
  assert.equal(includedLeft(p), PLAN_SECS - 100 * 60);
  const over = org({ plan_status: "active", plan_period_end: now + 86400_000, included_secs_used: PLAN_SECS + 600 });
  assert.equal(includedLeft(over), 0);
  assert.equal(entitled(env, over), true, "overage is invoiced, not blocked");
  assert.equal(trialActive(org({ plan_status: "active", plan_period_end: now + 1000, trial_ends_at: now + 1000 })), false, "the plan replaces the trial");
});

test("a lapsed or canceled plan is not a plan", () => {
  assert.equal(planActive(org({ plan_status: "active", plan_period_end: now - 1000 })), false);
  assert.equal(planActive(org({ plan_status: "canceled", plan_period_end: now + 86400_000 })), false);
  assert.equal(planActive(org({ plan_status: "past_due", plan_period_end: now + 86400_000 })), true, "a failed payment gets Stripe's retries");
});
