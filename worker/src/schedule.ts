/**
 * Per-subscriber settings, and the brief the morning call is placed from.
 *
 * The split matters. A *brief* is what to talk about — written by the loop on
 * the user's machine, which is the only thing that has read the pull requests.
 * A *setting* is when to talk about it, which is a property of the person, not
 * of the night's work. Keeping them apart is what lets the same brief be
 * delivered at 08:00, or twenty minutes early because the user rang in.
 */

import type { Env } from "./index";
import { isValidTimezone, parseClock, nextOccurrence } from "./time";

/** When the call goes out if the user never says otherwise. */
const DEFAULT_CALL_AT = "08:00";

/**
 * How long a brief stays interesting. Two days covers a missed call and a
 * weekend lie-in; past that, last night's PR queue is not news.
 */
const BRIEF_TTL_SECS = 48 * 60 * 60;

export interface Settings {
  /** Local wall-clock time of the morning call, "HH:MM". */
  callAt: string;
  /**
   * IANA zone the callAt is read in.
   *
   * Not a preference — it is whatever the CLI last reported its machine to be
   * set to, refreshed on every settings call. There is deliberately no way for
   * a person to set this: the laptop already knows, and a second copy of the
   * answer is a second copy to get wrong.
   */
  timezone: string;
  /** False parks briefs without ever dialling — for pausing without cancelling. */
  callEnabled: boolean;
  updatedAt: number;
}

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

const settingsKey = (phone: string) => `settings:${phone}`;
const briefKey = (phone: string) => `brief:${phone}`;

/* --------------------------------------------------------------- settings */

/**
 * Settings for a number, inventing sensible ones on first read.
 *
 * UTC is the fallback rather than a guess from the dialling code, because the
 * CLI reports the machine's real zone on the very first call and a guess would
 * only ever be visible in the window before that. A wrong guess that looks
 * like an answer is worse than an obviously neutral default.
 */
export async function loadSettings(env: Env, phone: string): Promise<Settings> {
  const raw = await env.CALLS.get(settingsKey(phone));
  if (raw) return JSON.parse(raw) as Settings;

  return {
    callAt: DEFAULT_CALL_AT,
    timezone: "UTC",
    callEnabled: true,
    updatedAt: 0,
  };
}

export interface SettingsPatch {
  callAt?: unknown;
  timezone?: unknown;
  callEnabled?: unknown;
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
  const current = await loadSettings(env, phone);
  const next: Settings = { ...current, updatedAt: Date.now() };

  if (patch.callAt !== undefined) {
    if (typeof patch.callAt !== "string" || !parseClock(patch.callAt))
      return { ok: false, error: "callAt must be 24-hour HH:MM, e.g. 08:00" };
    next.callAt = patch.callAt.trim();
  }

  if (patch.timezone !== undefined) {
    if (typeof patch.timezone !== "string" || !isValidTimezone(patch.timezone))
      return {
        ok: false,
        error: "timezone must be an IANA zone, e.g. Europe/Amsterdam",
      };
    next.timezone = patch.timezone;
  }

  if (patch.callEnabled !== undefined) {
    if (typeof patch.callEnabled !== "boolean")
      return { ok: false, error: "callEnabled must be true or false" };
    next.callEnabled = patch.callEnabled;
  }

  await env.CALLS.put(settingsKey(phone), JSON.stringify(next));

  // A brief already parked for the old time would otherwise keep the old time,
  // which is the least defensible way to answer "I moved my call to 06:30".
  const brief = await loadBrief(env, phone);
  if (brief && brief.status === "parked" && brief.dueAt !== null) {
    brief.dueAt = nextCallTime(next);
    await saveBrief(env, phone, brief);
  }

  return { ok: true, settings: next };
}

/** The next instant the configured call time comes round, in UTC ms. */
export function nextCallTime(settings: Settings, from: number = Date.now()): number {
  const clock = parseClock(settings.callAt) ?? { hour: 8, minute: 0 };
  return nextOccurrence(clock, settings.timezone, from);
}

/* ----------------------------------------------------------------- briefs */

export async function loadBrief(env: Env, phone: string): Promise<Brief | null> {
  const raw = await env.CALLS.get(briefKey(phone));
  return raw ? (JSON.parse(raw) as Brief) : null;
}

export async function saveBrief(env: Env, phone: string, brief: Brief): Promise<void> {
  await env.CALLS.put(briefKey(phone), JSON.stringify(brief), {
    expirationTtl: BRIEF_TTL_SECS,
  });
}

export async function clearBrief(env: Env, phone: string): Promise<void> {
  await env.CALLS.delete(briefKey(phone));
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

/**
 * Every brief whose time has come.
 *
 * A KV list per cron tick is the right shape while this is one number per
 * subscriber and the sweep runs twelve times an hour. If it ever isn't, the
 * fix is a due-time index, not a bigger list.
 */
export async function dueBriefs(
  env: Env,
  now: number = Date.now(),
): Promise<Array<{ phone: string; brief: Brief }>> {
  const due: Array<{ phone: string; brief: Brief }> = [];
  let cursor: string | undefined;

  do {
    const page = await env.CALLS.list({ prefix: "brief:", cursor });
    for (const key of page.keys) {
      const phone = key.name.slice("brief:".length);
      const brief = await loadBrief(env, phone);
      if (!brief || brief.status !== "parked" || brief.dueAt === null) continue;
      if (brief.dueAt <= now) due.push({ phone, brief });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return due;
}
