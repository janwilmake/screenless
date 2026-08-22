/**
 * Everything the Worker stores, in D1.
 *
 * D1 over a Durable Object because most of what the product shows is a query —
 * members with roles, invites with expiry, usage per day, the team's call
 * queue — and SQLite answers those in one statement each. The identity model:
 * a user belongs to exactly one org (`org_id` on the row), billing is a credit
 * balance on the org, and the ledger records every movement so the balance is
 * always explainable. Settings are columns on the user; calls, briefs,
 * watchers, the outbox, codes and rate-limit counters are their own tables.
 * The one thing not here is the parked edition PDF, which goes to R2.
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
  // Personal settings — the columns schedule.ts reads and writes.
  call_at: string;
  timezone: string;
  call_enabled: number;
  language: string;
  terms_accepted_at: number;
  email_verified_at: number;
  tokens_revoked_at: number;
  settings_updated_at: number;
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

/**
 * Resolves call targets — "all", or a list of emails/phones — to the org
 * members who can actually be dialled: same org, phone verified. This is the
 * widened invariant. `screenless call` used to only ever dial the caller's own
 * verified number; it can now dial teammates, but *only* verified numbers on
 * the caller's own team, so a stolen token still cannot reach a stranger.
 */
export async function resolveTargets(
  env: Env,
  orgId: string,
  targets: string[],
): Promise<{ members: User[]; unknown: string[] }> {
  const roster = (await members(env, orgId)).filter((m) => m.phone && m.phone_verified_at);

  if (targets.some((t) => t.toLowerCase() === "all")) {
    return { members: roster, unknown: [] };
  }

  const found: User[] = [];
  const unknown: string[] = [];
  for (const raw of targets) {
    const t = raw.trim().toLowerCase();
    const m = roster.find((u) => u.email?.toLowerCase() === t || u.phone === raw.trim());
    if (m && !found.some((f) => f.id === m.id)) found.push(m);
    else if (!m) unknown.push(raw.trim());
  }
  return { members: found, unknown };
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
    // Accepting proves the inbox: the invite only ever travelled by email, so
    // the address arrives verified — the paper can mail there right away.
    env.DB.prepare(
      "INSERT INTO users (id, org_id, email, name, role, email_verified_at, created_at) VALUES (?, ?, ?, ?, 'member', ?, ?)",
    ).bind(userId, invite.org_id, invite.email, name, now, now),
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

/**
 * Binds a verified phone to a user — taking it over if another account holds
 * it. The OTP just proved possession of the number, and possession is the
 * whole identity model: the old account loses the phone, and every CLI token
 * ever minted for it is revoked, because those tokens would otherwise start
 * resolving to the new owner.
 */
export async function setUserPhone(
  env: Env,
  userId: string,
  phone: string,
): Promise<{ ok: true; tookOverFrom: string | null }> {
  const holder = await userByPhone(env, phone);
  const takeover = holder && holder.id !== userId;
  const nowSecs = Math.floor(Date.now() / 1000);

  const statements = [];
  if (takeover) {
    statements.push(
      env.DB.prepare("UPDATE users SET phone = NULL, phone_verified_at = 0 WHERE id = ?").bind(holder.id),
    );
  }
  statements.push(
    takeover
      ? env.DB.prepare(
          "UPDATE users SET phone = ?, phone_verified_at = ?, tokens_revoked_at = ? WHERE id = ?",
        ).bind(phone, Date.now(), nowSecs, userId)
      : env.DB.prepare("UPDATE users SET phone = ?, phone_verified_at = ? WHERE id = ?")
          .bind(phone, Date.now(), userId),
  );
  await env.DB.batch(statements);
  return { ok: true, tookOverFrom: takeover ? holder.id : null };
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

/* ------------------------------------------------------------------- calls */

/** How long a watcher heartbeat counts as alive. Watchers poll well inside it. */
export const WATCHER_TTL_MS = 90 * 1000;
const CALL_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A call waiting in a team's queue lives a week, not a day. The queue is the
 * promise that a request made while nobody's terminal was watching is still
 * there when the next watcher spawns — a weekend must not eat it.
 */
const QUEUED_CALL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface TranscriptLine {
  role: string;
  text: string;
  at?: string;
}

export interface CallRecord {
  phone: string;
  userId?: string;
  orgId?: string;
  /** Who placed the call — the initiator. Equals userId for self-calls and
   *  ring-ins; the dispatcher for a teammate call, who may read it back. */
  initiatedBy?: string;
  /** Empty for a recorded-request call — no assistant was ever on the line. */
  assistantId: string;
  transcript?: TranscriptLine[];
  texmlAppId?: string;
  status: "initiated" | "ringing" | "answered" | "completed" | "failed";
  voicemail?: boolean;
  inbound?: boolean;
  /** brief = a conversation with the assistant; request = a recorded ask. */
  kind?: "brief" | "request";
  requestText?: string;
  recordingUrl?: string;
  /** Whether this call goes to the team's watchers when it finishes. */
  queued?: boolean;
  /** User id of whoever's watcher took it. Set once; the queue query skips it. */
  handledBy?: string;
  /** Guards the ledger against a duplicated end-of-call webhook. */
  debited?: boolean;
  conversationId?: string;
  createdAt: number;
  endedAt?: number;
}

function rowToCall(row: Record<string, unknown>): CallRecord {
  return {
    phone: String(row.phone),
    userId: (row.user_id as string) ?? undefined,
    orgId: (row.org_id as string) ?? undefined,
    initiatedBy: (row.initiated_by as string) ?? undefined,
    assistantId: String(row.assistant_id ?? ""),
    texmlAppId: (row.texml_app_id as string) ?? undefined,
    status: row.status as CallRecord["status"],
    voicemail: Boolean(row.voicemail),
    inbound: Boolean(row.inbound),
    kind: (row.kind as CallRecord["kind"]) ?? undefined,
    requestText: (row.request_text as string) ?? undefined,
    recordingUrl: (row.recording_url as string) ?? undefined,
    queued: Boolean(row.queued),
    handledBy: (row.handled_by as string) ?? undefined,
    debited: Boolean(row.debited),
    conversationId: (row.conversation_id as string) ?? undefined,
    transcript: row.transcript ? (JSON.parse(String(row.transcript)) as TranscriptLine[]) : undefined,
    createdAt: Number(row.created_at),
    endedAt: row.ended_at ? Number(row.ended_at) : undefined,
  };
}

export async function putCall(env: Env, id: string, r: CallRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO calls
       (id, org_id, user_id, initiated_by, phone, assistant_id, texml_app_id, status, voicemail,
        inbound, kind, request_text, recording_url, queued, handled_by, debited,
        conversation_id, transcript, created_at, ended_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    r.orgId ?? null,
    r.userId ?? null,
    r.initiatedBy ?? null,
    r.phone,
    r.assistantId,
    r.texmlAppId ?? null,
    r.status,
    r.voicemail ? 1 : 0,
    r.inbound ? 1 : 0,
    r.kind ?? null,
    r.requestText ?? null,
    r.recordingUrl ?? null,
    r.queued ? 1 : 0,
    r.handledBy ?? null,
    r.debited ? 1 : 0,
    r.conversationId ?? null,
    r.transcript ? JSON.stringify(r.transcript) : null,
    r.createdAt,
    r.endedAt ?? null,
    r.createdAt + (r.queued ? QUEUED_CALL_TTL_MS : CALL_TTL_MS),
  ).run();
}

export async function getCall(env: Env, id: string): Promise<CallRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM calls WHERE id = ? AND expires_at > ?")
    .bind(id, Date.now()).first<Record<string, unknown>>();
  return row ? rowToCall(row) : null;
}

export async function deleteCall(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM calls WHERE id = ?").bind(id).run();
}

export async function latestCallFor(
  env: Env,
  phone: string,
): Promise<{ id: string; record: CallRecord } | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM calls WHERE phone = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
  ).bind(phone, Date.now()).first<Record<string, unknown>>();
  return row ? { id: String(row.id), record: rowToCall(row) } : null;
}

/** The team's queue *is* this query: finished, meant for a watcher, untaken. */
export async function queuedCalls(
  env: Env,
  orgId: string,
): Promise<Array<{ id: string; record: CallRecord }>> {
  const res = await env.DB.prepare(
    `SELECT * FROM calls
     WHERE org_id = ? AND queued = 1 AND status = 'completed' AND voicemail = 0
       AND handled_by IS NULL AND expires_at > ?
     ORDER BY created_at LIMIT 20`,
  ).bind(orgId, Date.now()).all<Record<string, unknown>>();
  return (res.results ?? []).map((row) => ({ id: String(row.id), record: rowToCall(row) }));
}

/** Claims a queued call. False if someone else already had. */
export async function markHandled(env: Env, orgId: string, callId: string, userId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE calls SET handled_by = ? WHERE id = ? AND org_id = ? AND handled_by IS NULL",
  ).bind(userId, callId, orgId).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function staleInboundCalls(
  env: Env,
  olderThan: number,
): Promise<Array<{ id: string; record: CallRecord }>> {
  const res = await env.DB.prepare(
    "SELECT * FROM calls WHERE inbound = 1 AND status = 'answered' AND created_at < ?",
  ).bind(olderThan).all<Record<string, unknown>>();
  return (res.results ?? []).map((row) => ({ id: String(row.id), record: rowToCall(row) }));
}

/* ---------------------------------------------------------------- watchers */

export interface WatcherInfo {
  watcherId: string;
  userId: string;
  startedAt: number;
  repo: string;
}

export async function heartbeatWatcher(
  env: Env,
  orgId: string,
  w: WatcherInfo,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchers (org_id, watcher_id, user_id, repo, started_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id, watcher_id) DO UPDATE SET last_seen = excluded.last_seen`,
  ).bind(orgId, w.watcherId, w.userId, w.repo, w.startedAt, Date.now()).run();
}

export async function liveWatchers(env: Env, orgId: string): Promise<WatcherInfo[]> {
  const res = await env.DB.prepare(
    "SELECT watcher_id, user_id, started_at, repo FROM watchers WHERE org_id = ? AND last_seen > ?",
  ).bind(orgId, Date.now() - WATCHER_TTL_MS).all<Record<string, unknown>>();
  return (res.results ?? []).map((r) => ({
    watcherId: String(r.watcher_id),
    userId: String(r.user_id),
    startedAt: Number(r.started_at),
    repo: String(r.repo ?? ""),
  }));
}

/* ------------------------------------------------------------------- stash */

/** Short-lived values: codes, pending phone numbers, polling hints. */
export async function stashPut(env: Env, key: string, value: string, ttlSecs: number): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO stash (key, value, expires_at) VALUES (?, ?, ?)",
  ).bind(key, value, Date.now() + ttlSecs * 1000).run();
}

export async function stashGet(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM stash WHERE key = ? AND expires_at > ?")
    .bind(key, Date.now()).first<{ value: string }>();
  return row?.value ?? null;
}

export async function stashDelete(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM stash WHERE key = ?").bind(key).run();
}

/* -------------------------------------------------------------- revocation */

export async function revokeTokens(env: Env, phone: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET tokens_revoked_at = ? WHERE phone = ?")
    .bind(Math.floor(Date.now() / 1000), phone).run();
}

/** Tokens issued before this instant (epoch seconds) are void. */
export async function revokedBefore(env: Env, phone: string): Promise<number> {
  const row = await env.DB.prepare("SELECT tokens_revoked_at FROM users WHERE phone = ?")
    .bind(phone).first<{ tokens_revoked_at: number }>();
  return row?.tokens_revoked_at ?? 0;
}

/* ----------------------------------------------------------------- cleanup */

/** The cron's broom: TTLs were free in KV, here they are one sweep. */
export async function cleanupExpired(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM calls WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM briefs WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM stash WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM counters WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM watchers WHERE last_seen < ?").bind(now - 24 * 60 * 60 * 1000),
  ]);
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
