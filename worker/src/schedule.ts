/**
 * Per-person settings, and the brief the morning call is placed from.
 *
 * Settings are columns on the user row — when the call rings, in which zone,
 * in what language, where the paper mails. They used to be a KV blob keyed by
 * phone; folding them into `users` removed a second identity store and the
 * email-sync glue between the two.
 *
 * The split with briefs still matters. A *brief* is what to talk about —
 * written by the loop on the user's machine, which is the only thing that has
 * read the pull requests. A *setting* is when to talk about it, which is a
 * property of the person, not of the night's work. Keeping them apart is what
 * lets the same brief be delivered at 08:00, or twenty minutes early because
 * the user rang in.
 */

import type { Env } from "./index";
import * as db from "./db";
import { isValidTimezone, parseClock, nextOccurrence } from "./time";
import { DEFAULT_LANGUAGE, isSupportedLanguage } from "./languages";

/**
 * How long a brief stays interesting. Two days covers a missed call and a
 * weekend lie-in; past that, last night's PR queue is not news.
 */
const BRIEF_TTL_MS = 48 * 60 * 60 * 1000;

/** The shape the CLI has always read; mapped from the user row. */
export interface Settings {
  callAt: string;
  timezone: string;
  callEnabled: boolean;
  language: string;
  termsAcceptedAt: number;
  email: string;
  emailVerifiedAt: number;
  updatedAt: number;
}

export function settingsOf(user: db.User): Settings {
  return {
    callAt: user.call_at,
    timezone: user.timezone,
    callEnabled: Boolean(user.call_enabled),
    language: user.language,
    termsAcceptedAt: user.terms_accepted_at,
    email: user.email ?? "",
    emailVerifiedAt: user.email_verified_at,
    updatedAt: user.settings_updated_at,
  };
}

/** Settings for a verified phone; the user row is created on first sight. */
export async function loadSettings(env: Env, phone: string): Promise<Settings> {
  const { user } = await db.ensureUserForPhone(env, phone);
  return settingsOf(user);
}

export interface SettingsPatch {
  callAt?: unknown;
  timezone?: unknown;
  callEnabled?: unknown;
  language?: unknown;
  acceptTerms?: unknown;
  email?: unknown;
  emailVerifiedAt?: unknown;
}

/**
 * Applies a partial update. Returns an error string rather than throwing,
 * because every failure here is a user typo with a specific fix.
 */
export async function updateSettings(
  env: Env,
  phone: string,
  patch: SettingsPatch,
): Promise<{ ok: true; settings: Settings } | { ok: false; error: string }> {
  const { user } = await db.ensureUserForPhone(env, phone);

  const sets: string[] = ["settings_updated_at = ?"];
  const binds: unknown[] = [Date.now()];

  if (patch.callAt !== undefined) {
    if (typeof patch.callAt !== "string" || !parseClock(patch.callAt))
      return { ok: false, error: "callAt must be 24-hour HH:MM, e.g. 08:00" };
    sets.push("call_at = ?");
    binds.push(patch.callAt.trim());
  }

  if (patch.timezone !== undefined) {
    if (typeof patch.timezone !== "string" || !isValidTimezone(patch.timezone))
      return { ok: false, error: "timezone must be an IANA zone, e.g. Europe/Amsterdam" };
    sets.push("timezone = ?");
    binds.push(patch.timezone);
  }

  if (patch.language !== undefined) {
    if (!isSupportedLanguage(patch.language)) return { ok: false, error: "unsupported language" };
    sets.push("language = ?");
    binds.push(patch.language as string);
  }

  // Set together by /email/verify and nowhere else, so an address can never be
  // marked confirmed without a code having been redeemed for it. Unique across
  // users — the address doubles as the team-page sign-in.
  if (patch.email !== undefined && patch.emailVerifiedAt !== undefined) {
    if (typeof patch.email !== "string" || !patch.email.includes("@"))
      return { ok: false, error: "invalid email" };
    const holder = await db.userByEmail(env, patch.email);
    if (holder && holder.id !== user.id)
      return { ok: false, error: "that email is already on another screenless account" };
    sets.push("email = ?", "email_verified_at = ?");
    binds.push(patch.email.toLowerCase(), Number(patch.emailVerifiedAt) || Date.now());
  }

  // Write-once and never cleared: acceptance is a record of something that
  // happened, not a toggle. Re-accepting refreshes the timestamp; nothing
  // un-accepts.
  if (patch.acceptTerms === true) {
    sets.push("terms_accepted_at = ?");
    binds.push(Date.now());
  }

  if (patch.callEnabled !== undefined) {
    if (typeof patch.callEnabled !== "boolean")
      return { ok: false, error: "callEnabled must be true or false" };
    sets.push("call_enabled = ?");
    binds.push(patch.callEnabled ? 1 : 0);
  }

  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, user.id).run();

  const fresh = (await db.userById(env, user.id))!;
  const settings = settingsOf(fresh);

  // A brief already parked for the old time would otherwise keep the old time,
  // which is the least defensible way to answer "I moved my call to 06:30".
  const brief = await loadBrief(env, phone);
  if (brief && brief.status === "parked" && brief.dueAt !== null) {
    brief.dueAt = nextCallTime(settings);
    await saveBrief(env, phone, brief);
  }

  return { ok: true, settings };
}

/** The next instant the configured call time comes round, in UTC ms. */
export function nextCallTime(settings: Settings, from: number = Date.now()): number {
  const clock = parseClock(settings.callAt) ?? { hour: 8, minute: 0 };
  return nextOccurrence(clock, settings.timezone, from);
}

/* ----------------------------------------------------------------- briefs */

export interface Brief {
  prompt: string;
  language: string;
  /** When to dial, ms since epoch. Null means "held, dial only on request". */
  dueAt: number | null;
  status: "parked" | "placed";
  /** Dials attempted. A declined call is not a failure to retry forever. */
  attempts: number;
  /** The call this brief was last delivered on, so a transcript can be found. */
  callId?: string;
  createdAt: number;
}

export async function loadBrief(env: Env, phone: string): Promise<Brief | null> {
  const row = await env.DB.prepare("SELECT * FROM briefs WHERE phone = ? AND expires_at > ?")
    .bind(phone, Date.now()).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    prompt: String(row.prompt),
    language: String(row.language),
    dueAt: row.due_at === null ? null : Number(row.due_at),
    status: row.status as Brief["status"],
    attempts: Number(row.attempts),
    callId: (row.call_id as string) ?? undefined,
    createdAt: Number(row.created_at),
  };
}

export async function saveBrief(env: Env, phone: string, brief: Brief): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO briefs (phone, prompt, language, due_at, status, attempts, call_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    phone,
    brief.prompt,
    brief.language,
    brief.dueAt,
    brief.status,
    brief.attempts,
    brief.callId ?? null,
    brief.createdAt,
    brief.createdAt + BRIEF_TTL_MS,
  ).run();
}

export async function clearBrief(env: Env, phone: string): Promise<void> {
  await env.DB.prepare("DELETE FROM briefs WHERE phone = ?").bind(phone).run();
}

/**
 * Parks tonight's brief for delivery.
 *
 * `at` is an explicit "HH:MM" override; without one the brief lands on the
 * user's configured call time. A brief with `dueAt: null` is held rather than
 * scheduled — the loop can leave something ready for whenever the user rings
 * in, without a phone going off at dawn.
 */
export async function parkBrief(
  env: Env,
  phone: string,
  input: { prompt: string; language: string; at?: string; hold?: boolean },
): Promise<{ ok: true; brief: Brief } | { ok: false; error: string }> {
  const settings = await loadSettings(env, phone);

  let dueAt: number | null;
  if (input.hold) {
    dueAt = null;
  } else if (input.at) {
    const clock = parseClock(input.at);
    if (!clock) return { ok: false, error: "--at must be 24-hour HH:MM, e.g. 06:30" };
    dueAt = nextOccurrence(clock, settings.timezone);
  } else {
    dueAt = nextCallTime(settings);
  }

  const brief: Brief = {
    prompt: input.prompt,
    language: input.language,
    dueAt,
    status: "parked",
    attempts: 0,
    createdAt: Date.now(),
  };
  await saveBrief(env, phone, brief);
  return { ok: true, brief };
}

/** Every brief whose time has come — one indexed query, no scan. */
export async function dueBriefs(
  env: Env,
  now: number = Date.now(),
): Promise<Array<{ phone: string; brief: Brief }>> {
  const res = await env.DB.prepare(
    "SELECT phone FROM briefs WHERE status = 'parked' AND due_at IS NOT NULL AND due_at <= ? AND expires_at > ?",
  ).bind(now, now).all<{ phone: string }>();

  const due: Array<{ phone: string; brief: Brief }> = [];
  for (const { phone } of res.results ?? []) {
    const brief = await loadBrief(env, phone);
    if (brief) due.push({ phone, brief });
  }
  return due;
}
