/**
 * Scheduled delivery of an edition.
 *
 * The paper is built at 03:00 and must arrive at 06:30. Sending it immediately
 * would defeat the product — an inbox notification at three in the morning is
 * the opposite of screenless. So the CLI hands the PDF here, the Worker parks
 * it, and a cron sweep sends it when it is due.
 *
 * Parking happens server-side rather than with a local `at` job because the
 * laptop that built the paper is usually asleep by the time it should send.
 */
import type { Env } from "./index";

/** KV key prefix for parked mail. The epoch is in the key so the sweep can
 *  decide what is due by string comparison, without reading every value. */
const OUTBOX = "outbox:";

/** Parked items expire a week after their send time, sent or not. */
const OUTBOX_TTL_SECS = 7 * 24 * 60 * 60;

/** Cap a single attachment. A newspaper that big is a bug, not an edition. */
const MAX_BYTES = 12 * 1024 * 1024;

export interface OutboxItem {
  to: string;
  subject: string;
  filename: string;
  /** Base64 PDF. Stored as-is so the sweep can hand it straight to the API. */
  contentBase64: string;
  sendAt: number;
  createdAt: number;
}

/** Zero-padded epoch seconds, so lexical order matches chronological order. */
const stamp = (epochSecs: number) => String(epochSecs).padStart(12, "0");

/**
 * Resolve a requested send time to an epoch.
 *
 * Accepts either a full ISO instant, or a bare "HH:MM" meaning the next
 * occurrence of that wall-clock time in the given UTC offset. The offset is
 * explicit because a Worker has no idea what timezone the reader wakes up in.
 */
export function resolveSendAt(at: string, offsetMinutes: number, now = Date.now()): number | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(at)) {
    const t = Date.parse(at);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }

  const m = at.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;

  // Work in the reader's local wall clock by shifting into it, picking the
  // next occurrence, then shifting back.
  const offsetMs = offsetMinutes * 60_000;
  const local = new Date(now + offsetMs);
  const target = new Date(local);
  target.setUTCHours(hour, minute, 0, 0);
  if (target.getTime() <= local.getTime()) target.setUTCDate(target.getUTCDate() + 1);

  return Math.floor((target.getTime() - offsetMs) / 1000);
}

/** POST /mail — park an edition for later delivery. */
export async function scheduleMail(
  body: unknown,
  env: Env,
): Promise<{ ok: true; id: string; sendAt: string } | { ok: false; status: number; error: string }> {
  const b = (body ?? {}) as Record<string, unknown>;

  const to = typeof b.to === "string" && b.to ? b.to : env.MAIL_TO;
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
    return { ok: false, status: 400, error: "a valid `to` address is required (or set MAIL_TO)" };

  if (typeof b.contentBase64 !== "string" || !b.contentBase64)
    return { ok: false, status: 400, error: "contentBase64 is required" };

  // base64 is 4 chars per 3 bytes; check before decoding anything.
  if ((b.contentBase64.length * 3) / 4 > MAX_BYTES)
    return { ok: false, status: 413, error: `attachment exceeds ${MAX_BYTES / 1024 / 1024}MB` };

  const at = typeof b.at === "string" ? b.at : "";
  const offset = Number.isFinite(b.offsetMinutes) ? Number(b.offsetMinutes) : 0;
  const sendAt = at ? resolveSendAt(at, offset) : Math.floor(Date.now() / 1000);
  if (sendAt === null) return { ok: false, status: 400, error: "`at` must be HH:MM or an ISO instant" };

  const id = crypto.randomUUID();
  const item: OutboxItem = {
    to,
    subject: typeof b.subject === "string" && b.subject ? b.subject : "screenless",
    filename: typeof b.filename === "string" && b.filename ? b.filename : "edition.pdf",
    contentBase64: b.contentBase64,
    sendAt,
    createdAt: Math.floor(Date.now() / 1000),
  };

  await env.CALLS.put(`${OUTBOX}${stamp(sendAt)}:${id}`, JSON.stringify(item), {
    expirationTtl: Math.max(60, sendAt - Math.floor(Date.now() / 1000) + OUTBOX_TTL_SECS),
  });

  return { ok: true, id, sendAt: new Date(sendAt * 1000).toISOString() };
}

/**
 * Cron sweep — send everything now due.
 *
 * Deletes the key *before* sending. A duplicate paper is a worse failure than a
 * missing one: the reader trusts that what lands at 06:30 is tonight's edition,
 * and two copies make them check which is which.
 */
export async function sweepOutbox(env: Env): Promise<{ sent: number; failed: number }> {
  const nowKey = `${OUTBOX}${stamp(Math.floor(Date.now() / 1000))}`;
  let sent = 0;
  let failed = 0;
  let cursor: string | undefined;

  do {
    const page = await env.CALLS.list({ prefix: OUTBOX, cursor, limit: 100 });
    cursor = page.list_complete ? undefined : page.cursor;

    for (const key of page.keys) {
      // Keys sort chronologically, so anything past "now" is not due yet — and
      // because the listing is ordered, nothing after it is either.
      if (key.name > nowKey) return { sent, failed };

      const raw = await env.CALLS.get(key.name);
      await env.CALLS.delete(key.name);
      if (!raw) continue;

      try {
        await send(JSON.parse(raw) as OutboxItem, env);
        sent += 1;
      } catch {
        failed += 1;
      }
    }
  } while (cursor);

  return { sent, failed };
}

async function send(item: OutboxItem, env: Env): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || "screenless <press@screenless.sh>",
      to: [item.to],
      subject: item.subject,
      text:
        "Tonight's edition is attached.\n\n" +
        "Print it, or don't — but don't answer it. Anything that needs a decision " +
        "is on the call.\n",
      attachments: [{ filename: item.filename, content: item.contentBase64 }],
    }),
  });

  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}
