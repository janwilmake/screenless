/**
 * Users, organizations, invites and the money ledger, in D1.
 *
 * D1 over a Durable Object because everything the team and billing pages show
 * is a query — members with roles, invites with expiry, usage per day and per
 * member — and SQLite answers those in one statement each. The identity model:
 * a user belongs to exactly one org (`org_id` on the row), billing is a credit
 * balance on the org, and the ledger records every movement so the balance is
 * always explainable.
 *
 * Call records, briefs and settings stay in KV — they are single-key,
 * TTL-bound state and D1 would buy them nothing.
 */

import type { Env } from "./index";

export interface Org {
  id: string;
  name: string;
  credit_cents: number;
  stripe_customer_id: string | null;
  created_at: number;
}

export interface User {
  id: string;
  org_id: string;
  email: string | null;
  phone: string | null;
  name: string;
  role: "admin" | "member";
  phone_verified_at: number;
  phone_reminder_sent_at: number;
  created_at: number;
}

export interface Invite {
  token: string;
  org_id: string;
  email: string;
  invited_by: string;
  created_at: number;
  expires_at: number;
  accepted_at: number;
}

/** Credit a fresh org starts with. ~$10, the free plan. */
export const freeCreditCents = (env: Env): number =>
  Math.max(0, parseInt(env.FREE_CREDIT_CENTS || "1000", 10) || 1000);

/** What a minute of call costs the org. Roughly double what it costs us. */
export const priceCentsPerMinute = (env: Env): number =>
  Math.max(1, parseInt(env.PRICE_PER_MINUTE_CENTS || "30", 10) || 30);

/** Invites die after a week; the row stays so the page can say "expired". */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* ----------------------------------------------------------------- lookups */

export async function userByPhone(env: Env, phone: string): Promise<User | null> {
  return (await env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<User>()) ?? null;
}

export async function userByEmail(env: Env, email: string): Promise<User | null> {
  return (
    (await env.DB.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE")
      .bind(email.toLowerCase())
      .first<User>()) ?? null
  );
}

export async function userById(env: Env, id: string): Promise<User | null> {
  return (await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>()) ?? null;
}

export async function orgById(env: Env, id: string): Promise<Org | null> {
  return (await env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(id).first<Org>()) ?? null;
}

export async function members(env: Env, orgId: string): Promise<User[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM users WHERE org_id = ? ORDER BY created_at",
  ).bind(orgId).all<User>();
  return res.results ?? [];
}

/** Open invites, expired ones included — the page shows both. */
export async function invitesFor(env: Env, orgId: string): Promise<Invite[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM invites WHERE org_id = ? AND accepted_at = 0 ORDER BY created_at DESC",
  ).bind(orgId).all<Invite>();
  return res.results ?? [];
}

export async function inviteByToken(env: Env, token: string): Promise<Invite | null> {
  return (await env.DB.prepare("SELECT * FROM invites WHERE token = ?").bind(token).first<Invite>()) ?? null;
}

/* ---------------------------------------------------------------- identity */

/**
 * The user behind a verified phone, created on first sight.
 *
 * Resolution order matters: (1) the phone is already known; (2) the account's
 * confirmed email matches an invited user who has no phone yet — that is the
 * invitee finishing setup through the CLI instead of the web page, and it must
 * land on their invited row, not mint a rival org; (3) a brand-new solo org,
 * seeded with the free credit.
 */
export async function ensureUserForPhone(
  env: Env,
  phone: string,
  email?: string,
): Promise<{ user: User; org: Org }> {
  let user = await userByPhone(env, phone);

  if (!user && email) {
    const byEmail = await userByEmail(env, email);
    if (byEmail && !byEmail.phone) {
      await env.DB.prepare(
        "UPDATE users SET phone = ?, phone_verified_at = ? WHERE id = ? AND phone IS NULL",
      ).bind(phone, Date.now(), byEmail.id).run();
      user = await userById(env, byEmail.id);
    }
  }

  if (!user) {
    const created = await createOrgWithUser(env, { phone, email });
    return created;
  }

  // Backfill an email confirmed after the row was created. Never overwrites,
  // and a conflict with another row's unique email just leaves it blank.
  if (email && !user.email) {
    await env.DB.prepare(
      "UPDATE users SET email = ? WHERE id = ? AND email IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?)",
    ).bind(email.toLowerCase(), user.id, email.toLowerCase()).run();
    user.email = user.email ?? email.toLowerCase();
  }

  const org = await orgById(env, user.org_id);
  if (!org) throw new Error(`user ${user.id} points at missing org ${user.org_id}`);
  return { user, org };
}

/** A new solo org: the creator is its admin and the free credit is granted. */
export async function createOrgWithUser(
  env: Env,
  input: { phone?: string; email?: string; name?: string },
): Promise<{ user: User; org: Org }> {
  const now = Date.now();
  const orgId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const grant = freeCreditCents(env);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO orgs (id, name, credit_cents, created_at) VALUES (?, ?, ?, ?)")
      .bind(orgId, "My team", grant, now),
    env.DB.prepare(
      "INSERT INTO users (id, org_id, email, phone, name, role, phone_verified_at, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)",
    ).bind(
      userId,
      orgId,
      input.email?.toLowerCase() ?? null,
      input.phone ?? null,
      input.name ?? "",
      input.phone ? now : 0,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO ledger (id, org_id, user_id, kind, delta_cents, memo, created_at) VALUES (?, ?, ?, 'grant', ?, 'free credit', ?)",
    ).bind(`grant:${orgId}`, orgId, userId, grant, now),
  ]);

  const user = await userById(env, userId);
  const org = await orgById(env, orgId);
  if (!user || !org) throw new Error("org creation raced");
  return { user, org };
}

/* ----------------------------------------------------------------- invites */

/**
 * One live invite per (org, email): re-inviting replaces the old token and
 * restarts the week, which is also how "resend" works for an expired one.
 */
export async function upsertInvite(
  env: Env,
  orgId: string,
  email: string,
  invitedBy: string,
): Promise<Invite> {
  const now = Date.now();
  const token = [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE org_id = ? AND email = ? COLLATE NOCASE AND accepted_at = 0")
      .bind(orgId, email.toLowerCase()),
    env.DB.prepare(
      "INSERT INTO invites (token, org_id, email, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(token, orgId, email.toLowerCase(), invitedBy, now, now + INVITE_TTL_MS),
  ]);

  const invite = await inviteByToken(env, token);
  if (!invite) throw new Error("invite creation raced");
  return invite;
}

export async function deleteInvite(env: Env, orgId: string, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM invites WHERE token = ? AND org_id = ?").bind(token, orgId).run();
}

/**
 * Accepting: an existing user (matched by the invited email) moves org — one
 * org per user, so joining is leaving. A new email becomes a fresh member row
 * with no phone yet; the phone step follows on the same page.
 */
export async function acceptInvite(
  env: Env,
  invite: Invite,
  name: string,
): Promise<User> {
  const now = Date.now();
  const existing = await userByEmail(env, invite.email);

  if (existing) {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET org_id = ?, role = 'member' WHERE id = ?")
        .bind(invite.org_id, existing.id),
      env.DB.prepare("UPDATE invites SET accepted_at = ? WHERE token = ?").bind(now, invite.token),
    ]);
    return (await userById(env, existing.id))!;
  }

  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, org_id, email, name, role, created_at) VALUES (?, ?, ?, ?, 'member', ?)",
    ).bind(userId, invite.org_id, invite.email, name, now),
    env.DB.prepare("UPDATE invites SET accepted_at = ? WHERE token = ?").bind(now, invite.token),
  ]);
  return (await userById(env, userId))!;
}

/* ----------------------------------------------------------------- members */

export async function renameOrg(env: Env, orgId: string, name: string): Promise<void> {
  await env.DB.prepare("UPDATE orgs SET name = ? WHERE id = ?").bind(name, orgId).run();
}

export async function setRole(env: Env, orgId: string, userId: string, role: "admin" | "member"): Promise<void> {
  await env.DB.prepare("UPDATE users SET role = ? WHERE id = ? AND org_id = ?")
    .bind(role, userId, orgId).run();
}

/**
 * Removing a member parks them in a fresh solo org rather than deleting the
 * row: their phone, email and history stay theirs, they just stop drawing on
 * this org's credit. No free grant the second time — one per person, ever.
 */
export async function removeMember(env: Env, orgId: string, userId: string): Promise<void> {
  const now = Date.now();
  const soloId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO orgs (id, name, credit_cents, created_at) VALUES (?, 'My team', 0, ?)")
      .bind(soloId, now),
    env.DB.prepare("UPDATE users SET org_id = ?, role = 'admin' WHERE id = ? AND org_id = ?")
      .bind(soloId, userId, orgId),
  ]);
}

/** Binds a verified phone to a user. Fails if another account holds it. */
export async function setUserPhone(
  env: Env,
  userId: string,
  phone: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const holder = await userByPhone(env, phone);
  if (holder && holder.id !== userId)
    return { ok: false, error: "that phone number is already on another screenless account" };
  await env.DB.prepare("UPDATE users SET phone = ?, phone_verified_at = ? WHERE id = ?")
    .bind(phone, Date.now(), userId).run();
  return { ok: true };
}

/* ------------------------------------------------------------------- money */

/**
 * Adds credit, exactly once per ledger id. The UPDATE runs before the INSERT
 * inside one batch transaction, so a replayed Stripe webhook — same session id,
 * same ledger id — changes nothing on either statement.
 */
export async function credit(
  env: Env,
  orgId: string,
  cents: number,
  kind: "grant" | "topup",
  memo: string,
  ledgerId: string,
  userId?: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE orgs SET credit_cents = credit_cents + ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM ledger WHERE id = ?)",
    ).bind(cents, orgId, ledgerId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO ledger (id, org_id, user_id, kind, delta_cents, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(ledgerId, orgId, userId ?? null, kind, cents, memo, Date.now()),
  ]);
}

/**
 * Charges a finished call. Keyed by call id so a duplicated status webhook
 * cannot bill twice, and allowed to push the balance below zero — the call
 * already happened; the gate stops the *next* one.
 */
export async function debitCall(
  env: Env,
  orgId: string,
  userId: string | null,
  callId: string,
  seconds: number,
  cents: number,
): Promise<void> {
  const ledgerId = `call:${callId}`;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE orgs SET credit_cents = credit_cents - ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM ledger WHERE id = ?)",
    ).bind(cents, orgId, ledgerId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO ledger (id, org_id, user_id, kind, delta_cents, seconds, memo, created_at) VALUES (?, ?, ?, 'call', ?, ?, ?, ?)",
    ).bind(ledgerId, orgId, userId, -cents, seconds, callId, Date.now()),
  ]);
}

export async function setStripeCustomer(env: Env, orgId: string, customerId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE orgs SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL",
  ).bind(customerId, orgId).run();
}

/* ------------------------------------------------------------------- stats */

export interface UsageStats {
  usedCents: number;
  usedSeconds: number;
  calls: number;
  perDay: Array<{ day: string; cents: number; seconds: number; calls: number }>;
  perMember: Array<{
    userId: string | null;
    name: string;
    email: string | null;
    calls: number;
    seconds: number;
    cents: number;
  }>;
  ledger: Array<{ kind: string; deltaCents: number; memo: string; createdAt: number }>;
}

/** Everything the billing tab shows, in four queries over the ledger. */
export async function usageStats(env: Env, orgId: string): Promise<UsageStats> {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const totals = await env.DB.prepare(
    "SELECT COALESCE(SUM(-delta_cents),0) c, COALESCE(SUM(seconds),0) s, COUNT(*) n FROM ledger WHERE org_id = ? AND kind = 'call'",
  ).bind(orgId).first<{ c: number; s: number; n: number }>();

  const perDay = await env.DB.prepare(
    `SELECT date(created_at/1000, 'unixepoch') day,
            SUM(-delta_cents) cents, SUM(seconds) seconds, COUNT(*) calls
     FROM ledger WHERE org_id = ? AND kind = 'call' AND created_at > ?
     GROUP BY day ORDER BY day`,
  ).bind(orgId, since).all<{ day: string; cents: number; seconds: number; calls: number }>();

  const perMember = await env.DB.prepare(
    `SELECT l.user_id userId, COALESCE(u.name, '') name, u.email email,
            COUNT(*) calls, SUM(l.seconds) seconds, SUM(-l.delta_cents) cents
     FROM ledger l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.org_id = ? AND l.kind = 'call'
     GROUP BY l.user_id ORDER BY cents DESC`,
  ).bind(orgId).all<{ userId: string | null; name: string; email: string | null; calls: number; seconds: number; cents: number }>();

  const recent = await env.DB.prepare(
    "SELECT kind, delta_cents deltaCents, memo, created_at createdAt FROM ledger WHERE org_id = ? ORDER BY created_at DESC LIMIT 20",
  ).bind(orgId).all<{ kind: string; deltaCents: number; memo: string; createdAt: number }>();

  return {
    usedCents: totals?.c ?? 0,
    usedSeconds: totals?.s ?? 0,
    calls: totals?.n ?? 0,
    perDay: perDay.results ?? [],
    perMember: perMember.results ?? [],
    ledger: recent.results ?? [],
  };
}

/* --------------------------------------------------------------- reminders */

/** Members who accepted over a day ago and still have no verified phone. */
export async function usersNeedingPhoneReminder(env: Env): Promise<User[]> {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const res = await env.DB.prepare(
    `SELECT * FROM users
     WHERE phone_verified_at = 0 AND phone_reminder_sent_at = 0
       AND email IS NOT NULL AND created_at < ?`,
  ).bind(dayAgo).all<User>();
  return res.results ?? [];
}

export async function markPhoneReminderSent(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET phone_reminder_sent_at = ? WHERE id = ?")
    .bind(Date.now(), userId).run();
}
