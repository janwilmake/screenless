/**
 * WhatsApp chats with a Claude Code session.
 *
 * A message to the line's WhatsApp number goes where a call would: the
 * sender's own session when it watches live, else a teammate's session that
 * serves them by their level. That watcher answers it in a fork of the
 * session, one fork per conversation, continued with each message until the
 * conversation has been quiet for half an hour, and the answer goes back as a
 * WhatsApp message. With no session live, the message joins the team's queue
 * like a call nobody could answer live, and the sender is told so at once.
 *
 * Telnyx signs every v2 webhook with Ed25519, and a message is only taken
 * when the signature checks out against its public key: the URL carries no
 * secret. A WhatsApp sender is tied to their account, as for a call, so a
 * verified member's number is them. Attachments are fetched here: images and
 * documents are kept in R2 for the watcher a day or two, and voice notes are
 * transcribed into the message's text.
 */

import type { Env } from "./index";
import * as db from "./db";
import * as levels from "./levels";
import * as telnyx from "./telnyx";
import * as openai from "./openai";
import * as billing from "./billing";
import { json, fail, normalizeCallerId, rateLimit, isE164 } from "./util";

export interface ChatMedia {
  /** R2 key, `chat/<servedBy>/<message id>/<n>`. */
  key: string;
  mime: string;
  kind: "image" | "document";
  name?: string;
}

/** One inbound message waiting for, or being answered by, a watcher. */
export interface ChatEntry {
  id: string;
  /** Meta's id for the message (wamid.…), which a reaction points at. */
  wamid?: string;
  /** The member whose session answers it. */
  servedBy: string;
  from: { userId: string; name: string; email: string | null; phone: string; level: string; you: boolean };
  text: string;
  media: ChatMedia[];
  at: number;
  claimedAt?: number;
  claimedBy?: string;
}

/** A message nobody has answered in this long is offered again. */
const CLAIM_MS = 10 * 60_000;
/** Kept this long for a session to come back and answer. */
const KEEP_SECS = 7 * 86400;
/** Attachments larger than this are not passed on. */
const MAX_MEDIA = 20 * 1024 * 1024;

const STRANGER =
  "This is a screenless line for teams: it reaches a team's Claude Code sessions. To use it, install screenless from screenless.sh, or ask your team for an invite.";

/* ---------------------------------------------------------------- webhook */

/** Whether Telnyx signed this body: Ed25519 over `<timestamp>|<body>`,
 *  within five minutes, against the account's public key. */
async function signedByTelnyx(env: Env, req: Request, raw: string): Promise<boolean> {
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts = req.headers.get("telnyx-timestamp");
  if (!env.TELNYX_PUBLIC_KEY || !sig || !ts) return false;
  if (!(Math.abs(Date.now() / 1000 - Number(ts)) <= 300)) return false;
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  try {
    const key = await crypto.subtle.importKey("raw", bytes(env.TELNYX_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, bytes(sig), new TextEncoder().encode(`${ts}|${raw}`));
  } catch {
    return false;
  }
}

/** The keys of a payload and the types of its values, for the log: what a
 *  message carries, never what it says or who sent it. */
function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === "object")
    return depth > 3
      ? "{…}"
      : Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === "type" || k === "event_type" ? x : shapeOf(x, depth + 1)]));
  return typeof v;
}

/**
 * Telnyx's WhatsApp webhook. Answers within Telnyx's few seconds whatever
 * happens, and does the slow part (attachments, transcription) after; a
 * retried delivery of the same message is taken once.
 */
export async function whatsappWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await req.text();
  if (!(await signedByTelnyx(env, req, raw))) {
    console.log("whatsapp webhook refused: signature", req.headers.get("telnyx-signature-ed25519") ? "invalid" : "missing");
    return fail(403, "bad signature");
  }
  let ev: { data?: { event_type?: string; payload?: Record<string, unknown> } };
  try {
    ev = JSON.parse(raw);
  } catch {
    return json({ ok: true });
  }
  const type = ev.data?.event_type ?? "";
  const p = (ev.data?.payload ?? ev) as Record<string, unknown>;
  // The WhatsApp Business Account's webhook says `whatsapp.messages` and
  // carries Meta's own shape (messages in a list, statuses beside them);
  // Telnyx's messaging docs describe `message.received` with the message
  // under `body`. Both are taken: the messages are looked for wherever
  // they sit. Delivery statuses and anything else are noted only.
  console.log("whatsapp event", type, JSON.stringify(shapeOf(p)));
  const found = messagesIn(p);
  if (type === "message.received" && !found.length) found.push((p.body && typeof p.body === "object" ? p.body : p) as Record<string, unknown>);
  for (const msg of found) {
    const id = String(msg.id ?? p.id ?? "");
    if (!id || (await db.stashGet(env, `waseen:${id}`))) continue;
    await db.stashPut(env, `waseen:${id}`, "1", 86400);
    ctx.waitUntil(take(env, p, msg, id).catch((err) => console.error("whatsapp message failed", id, (err as Error).message)));
  }
  return json({ ok: true });
}

/** Inbound message objects, wherever the payload nests them: Meta's
 *  `entry[].changes[].value.messages[]`, or a `messages` list at any depth.
 *  A message has a sender and a type; a delivery status has neither. */
function messagesIn(v: unknown, depth = 0): Array<Record<string, unknown>> {
  if (!v || typeof v !== "object" || depth > 6) return [];
  if (Array.isArray(v)) return v.flatMap((x) => messagesIn(x, depth + 1));
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.messages))
    return (o.messages as unknown[]).filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && "from" in m && "type" in m);
  return Object.entries(o).flatMap(([k, x]) => (k === "statuses" ? [] : messagesIn(x, depth + 1)));
}

const fromOf = (p: Record<string, unknown>, msg: Record<string, unknown>): string => {
  const f = p.from ?? msg.from;
  return String(f && typeof f === "object" ? (f as { phone_number?: string }).phone_number ?? "" : f ?? "");
};

async function reply(env: Env, to: string, text: string): Promise<void> {
  await telnyx.sendWhatsAppText(env.TELNYX_API_KEY, env.TELNYX_FROM_NUMBER, to, text, env.TELNYX_MESSAGING_PROFILE_ID || undefined).catch((err) =>
    console.error("whatsapp reply failed", (err as Error).message),
  );
}

async function take(env: Env, p: Record<string, unknown>, msg: Record<string, unknown>, id: string): Promise<void> {
  // A reaction is not a message to answer.
  if (msg.type === "reaction" || msg.reaction) return;
  const phone = normalizeCallerId(fromOf(p, msg));
  if (!isE164(phone)) return;
  const user = await db.userByPhone(env, phone);
  if (!user || !user.phone_verified_at) {
    if (await rateLimit(env, `wastranger:${phone}`, 1, 86400)) await reply(env, phone, STRANGER);
    return;
  }
  const found = await db.orgById(env, user.org_id);
  const org = found ? await billing.refreshPlan(env, found) : null;
  if (!org || !billing.chatAllowed(env, org)) {
    await reply(env, phone, "Your team's screenless trial has ended. An admin can start the team plan at screenless.sh/team.");
    return;
  }
  if (!(await rateLimit(env, `wamsg:${user.id}`, 60))) {
    await reply(env, phone, "That is a lot of messages this hour; give it a little while.");
    return;
  }

  // Where a call from them would go: their own live session, else a
  // teammate's that serves them.
  const own = await db.stashGet(env, `livewatch:${user.id}`);
  const shared = own
    ? null
    : await levels.sharedWatcher(env, org.id, { id: user.id, email: user.email, phone: user.phone ?? undefined, level: db.levelOf(user, org) });
  const servedBy = own ? user.id : shared?.userId ?? null;

  const { text, media } = await contentOf(env, msg, servedBy, id);
  if (!text.trim() && !media.length) return;

  if (!servedBy) {
    await queueForLater(env, user, org, text, media.length);
    await reply(
      env,
      phone,
      "No Claude Code session is answering right now, so your message is queued: the next one to watch the line picks it up." +
        (media.length ? " Attachments are not kept for later." : ""),
    );
    return;
  }

  const now = Date.now();
  // Meta's own message id: the message's `id` in Meta's shape, its
  // `foreign_id` in Telnyx's.
  const wamid = [msg.id, msg.foreign_id, p.foreign_id].map((x) => String(x ?? "")).find((x) => x.startsWith("wamid.")) ?? "";
  const entry: ChatEntry = {
    id,
    ...(wamid ? { wamid } : {}),
    servedBy,
    from: {
      userId: user.id,
      name: user.name ?? "",
      email: user.email,
      phone,
      level: db.levelOf(user, org),
      you: servedBy === user.id,
    },
    text,
    media,
    at: now,
  };
  const key = `chatin:${servedBy}:${now}:${id}`;
  await db.stashPut(env, key, JSON.stringify(entry), KEEP_SECS);
  await db.stashPut(env, `chatmsg:${id}`, key, KEEP_SECS);
}

/** The message's words, with voice notes transcribed in, and its images and
 *  documents saved for the watcher. */
async function contentOf(
  env: Env,
  msg: Record<string, unknown>,
  servedBy: string | null,
  id: string,
): Promise<{ text: string; media: ChatMedia[] }> {
  const parts: string[] = [];
  const media: ChatMedia[] = [];
  const text = (msg.text as { body?: string } | undefined)?.body;
  if (text) parts.push(text);
  const button = (msg.button as { text?: string } | undefined)?.text;
  const inter = msg.interactive as { button_reply?: { title?: string }; list_reply?: { title?: string } } | undefined;
  const choice = button ?? inter?.button_reply?.title ?? inter?.list_reply?.title;
  if (choice) parts.push(choice);

  for (const kind of ["image", "sticker", "document", "audio", "voice", "video"] as const) {
    const m = msg[kind] as { url?: string; id?: string; mime_type?: string; caption?: string; filename?: string } | undefined;
    if (!m) continue;
    if (m.caption) parts.push(m.caption);
    if (kind === "video") {
      parts.push("(They sent a video, which the line does not pass on.)");
      continue;
    }
    let body: ArrayBuffer;
    try {
      const res = m.url
        ? await fetchMedia(env, m.url)
        : m.id
          ? await telnyx.whatsappMedia(env.TELNYX_API_KEY, env.TELNYX_FROM_NUMBER, m.id)
          : null;
      if (!res || !res.ok) throw new Error(`media ${res?.status ?? "missing"}`);
      body = await res.arrayBuffer();
    } catch (err) {
      console.error("whatsapp media failed", id, kind, (err as Error).message);
      parts.push(`(They sent ${kind === "document" ? "a file" : `a ${kind}`} that could not be fetched.)`);
      continue;
    }
    if (body.byteLength > MAX_MEDIA) {
      parts.push(`(They sent ${kind === "document" ? "a file" : `a ${kind}`} too large to pass on.)`);
      continue;
    }
    const mime = m.mime_type ?? "";
    if (kind === "audio" || kind === "voice") {
      try {
        const words = await openai.transcribe(env.OPENAI_API_KEY, body, mime);
        parts.push(words ? `(voice message) ${words}` : "(an empty voice message)");
      } catch (err) {
        console.error("transcription failed", id, (err as Error).message);
        parts.push("(They sent a voice message that could not be transcribed.)");
      }
      continue;
    }
    // Images and files: kept for the watcher that answers, when one does.
    if (!servedBy) {
      parts.push(`(They attached ${kind === "document" ? "a file" : "an image"}.)`);
      continue;
    }
    const key = `chat/${servedBy}/${id}/${media.length}`;
    await env.OUTBOX.put(key, body, { httpMetadata: { contentType: mime || "application/octet-stream" } });
    media.push({ key, mime, kind: kind === "document" ? "document" : "image", ...(m.filename ? { name: m.filename } : {}) });
  }

  const loc = msg.location as { latitude?: number; longitude?: number; name?: string; address?: string } | undefined;
  if (loc) parts.push(`(Shared a location: ${[loc.name, loc.address, loc.latitude != null ? `${loc.latitude}, ${loc.longitude}` : ""].filter(Boolean).join(", ")})`);
  const contacts = msg.contacts as Array<{ name?: { formatted_name?: string } }> | undefined;
  if (contacts?.length) parts.push(`(Shared contact cards: ${contacts.map((c) => c.name?.formatted_name ?? "a contact").join(", ")})`);
  return { text: parts.join("\n"), media };
}

/** Telnyx-hosted media: tried as a plain link, then with the API key. */
async function fetchMedia(env: Env, url: string): Promise<Response> {
  const res = await fetch(url);
  if (res.status !== 401 && res.status !== 403) return res;
  return fetch(url, { headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}` } });
}

/** With no session live: a queued request, like a call nobody could answer
 *  live, for the next watcher to take. Free: no minutes were talked. */
async function queueForLater(env: Env, user: db.User, org: db.Org, text: string, attachments: number): Promise<void> {
  const now = Date.now();
  const words = `${text}${attachments ? `\n(${attachments} attachment${attachments === 1 ? "" : "s"}, not kept)` : ""}`.trim();
  await db.putCall(env, crypto.randomUUID(), {
    phone: user.phone!,
    userId: user.id,
    orgId: org.id,
    status: "completed",
    inbound: true,
    kind: "request",
    requestText: `(WhatsApp message) ${words}`,
    transcript: [{ role: "user", text: words, at: new Date(now).toISOString() }],
    queued: true,
    debited: true,
    createdAt: now,
    endedAt: now,
  });
}

/* ---------------------------------------------------------------- watcher */

/** Messages waiting for this member's live watcher, claimed for it. */
export async function pendingChats(env: Env, userId: string, watcherId: string): Promise<ChatEntry[]> {
  const out: ChatEntry[] = [];
  for (const { key, value } of await db.stashByPrefix(env, `chatin:${userId}:`)) {
    const e = JSON.parse(value) as ChatEntry;
    if (e.claimedAt && Date.now() - e.claimedAt < CLAIM_MS) continue;
    const claimed = { ...e, claimedAt: Date.now(), claimedBy: watcherId };
    if (!(await db.stashSwap(env, key, value, JSON.stringify(claimed), KEEP_SECS))) continue;
    out.push(claimed);
    // 👀 on their message: a live session has it, before any answer.
    if (e.wamid && !e.claimedAt)
      await telnyx
        .sendWhatsAppReaction(env.TELNYX_API_KEY, env.TELNYX_FROM_NUMBER, e.from.phone, e.wamid, "👀", env.TELNYX_MESSAGING_PROFILE_ID || undefined)
        .catch((err) => console.error("whatsapp reaction failed", e.id, (err as Error).message));
  }
  return out.sort((a, b) => a.at - b.at);
}

async function entryFor(env: Env, user: db.User, id: string): Promise<{ key: string; entry: ChatEntry } | null> {
  const key = typeof id === "string" && id ? await db.stashGet(env, `chatmsg:${id}`) : null;
  const raw = key ? await db.stashGet(env, key) : null;
  if (!key || !raw) return null;
  const entry = JSON.parse(raw) as ChatEntry;
  return entry.servedBy === user.id ? { key, entry } : null;
}

/**
 * The watcher's answer to a message, or a progress note on it. The answer
 * goes back as a WhatsApp message and closes the message; a note is sent at
 * most every 15 seconds, so a chatty fork cannot flood the person.
 */
export async function chatReply(env: Env, user: db.User, body: { id?: string; text?: string; progress?: boolean }): Promise<Response> {
  const found = await entryFor(env, user, String(body.id ?? ""));
  if (!found) return fail(404, "no such message waiting for you");
  const text = String(body.text ?? "").trim();
  if (!text) return fail(400, "text required");
  if (body.progress) {
    if (!(await rateLimit(env, `chatnote:${found.entry.id}`, 1, 15))) return json({ ok: true, sent: false, reason: "a note was just sent" });
    await reply(env, found.entry.from.phone, text);
    return json({ ok: true, sent: true });
  }
  await reply(env, found.entry.from.phone, text);
  await db.stashDelete(env, found.key);
  await db.stashDelete(env, `chatmsg:${found.entry.id}`);
  for (const m of found.entry.media) await env.OUTBOX.delete(m.key).catch(() => undefined);
  return json({ ok: true, sent: true });
}

/** An attachment, for the watcher that answers its message. */
export async function chatMedia(env: Env, user: db.User, key: string): Promise<Response> {
  if (!key.startsWith(`chat/${user.id}/`) || key.includes("..")) return fail(404, "not found");
  const obj = await env.OUTBOX.get(key);
  if (!obj) return fail(404, "not found");
  return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream" } });
}

/** Attachments of messages nobody answered, after two days. */
export async function sweepChatMedia(env: Env): Promise<number> {
  const cutoff = Date.now() - 2 * 86400_000;
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await env.OUTBOX.list({ prefix: "chat/", cursor });
    for (const o of page.objects)
      if (o.uploaded.getTime() < cutoff) {
        await env.OUTBOX.delete(o.key);
        n++;
      }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}
