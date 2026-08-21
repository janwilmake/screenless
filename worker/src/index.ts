import * as telnyx from "./telnyx";
import * as billing from "./billing";
import * as schedule from "./schedule";
import * as db from "./db";
import * as team from "./team";
import { LANGUAGES, DEFAULT_LANGUAGE, isSupportedLanguage, languageOf } from "./languages";
import { session, sign, webhookToken, safeEqual, revokeSessions } from "./auth";
import { scheduleMail, sweepOutbox, sendEmailCode, isEmail } from "./mail";
import {
  json,
  fail,
  isE164,
  normalizeCallerId,
  destinationAllowed,
  rateLimit,
} from "./util";

export interface Env {
  CALLS: KVNamespace;
  /** Users, orgs, invites and the money ledger. Schema in ../schema.sql. */
  DB: D1Database;
  /** The landing page, served from site/public by the assets binding. */
  ASSETS: Fetcher;

  // secrets — set with `wrangler secret put <NAME>`
  TELNYX_API_KEY: string;
  TELNYX_VERIFY_PROFILE_ID: string;
  SESSION_SECRET: string;
  ADMIN_SECRET: string;
  /**
   * Optional. While unset billing is inert: every org is entitled whatever its
   * balance says, which is what keeps `wrangler dev` usable.
   */
  STRIPE_SECRET_KEY: string;
  /** Signing secret for the Stripe webhook endpoint. */
  STRIPE_WEBHOOK_SECRET: string;
  /** Sends the nightly edition. Without it the outbox fills and never drains. */
  RESEND_API_KEY: string;

  // vars — set in wrangler.jsonc
  TELNYX_FROM_NUMBER: string;
  TELNYX_ANCHORSITE: string;
  ASSISTANT_MODEL: string;
  ASSISTANT_VOICE: string;
  ALLOWED_DESTINATIONS: string;
  /** Landing page origin; also the base for /team links in emails. */
  SITE_URL: string;
  /** This Worker's own hostname. Cron has no request to infer it from. */
  API_HOST: string;
  /** Envelope sender for everything mailed. Domain must be verified in Resend. */
  MAIL_FROM: string;
  MAIL_TO: string;
  /** What a minute of call bills an org, in cents. Roughly double our cost. */
  PRICE_PER_MINUTE_CENTS: string;
  /** What a fresh org starts with, in cents. The free plan. */
  FREE_CREDIT_CENTS: string;
}

/**
 * Sessions last a year.
 *
 * A week was wrong twice over: it expired on exactly the day the trial
 * converted, and it made a background loop re-verify by SMS every Monday. The
 * token is bound to a verified number and can only ever dial that number, so a
 * long life costs little — and `screenless logout` ends it immediately.
 */
const SESSION_TTL_SECS = 365 * 24 * 60 * 60;
/** Call records outlive the call itself so `screenless call` can be re-run against an id. */
const CALL_TTL_SECS = 24 * 60 * 60;
/**
 * A call waiting in a team's queue lives a week, not a day. The queue is the
 * promise that a request made while nobody's terminal was watching is still
 * there when the next watcher spawns — a weekend must not eat it.
 */
const QUEUED_CALL_TTL_SECS = 7 * 24 * 60 * 60;
/** How long a watcher heartbeat stays live. Watchers poll well inside this. */
const WATCHER_TTL_SECS = 90;
/** OTP sends allowed per phone number per hour. An SMS costs up to ~$0.09. */
const OTP_RATE_LIMIT = 5;
/**
 * OTP sends allowed across *all* numbers per hour.
 *
 * The per-number limit does nothing against the attack that actually happens:
 * one script, ten thousand different numbers, ten thousand messages on our
 * balance. That is SMS pumping, and now that destinations are worldwide it is
 * the largest unbounded cost in the system. A real signup burst will never see
 * this ceiling; a pump hits it in seconds.
 */
const OTP_GLOBAL_HOURLY = 60;
/** And a daily backstop, so a slow pump cannot run all night under the hourly cap. */
const OTP_GLOBAL_DAILY = 300;

interface TranscriptLine {
  role: string;
  text: string;
  at?: string;
}

interface CallRecord {
  phone: string;
  /** Who this call belongs to, for billing attribution and watcher routing. */
  userId?: string;
  orgId?: string;
  /** Empty for a recorded-request call — no assistant was ever on the line. */
  assistantId: string;
  /**
   * Copied off Telnyx once the call ends, so the conversation there can be
   * deleted. For a recorded request this is the transcription, one user line.
   */
  transcript?: TranscriptLine[];
  /** The app Telnyx auto-provisioned for this assistant; deleted alongside it. */
  texmlAppId?: string;
  status: "initiated" | "ringing" | "answered" | "completed" | "failed";
  /** Answered by a machine. The call was hung up, the brief re-parked held,
   *  and nothing here is a conversation worth collecting. */
  voicemail?: boolean;
  /** The user rang in. Its end is reported by the TeXML application's status
   *  callback, not per call — see finishInbound. */
  inbound?: boolean;
  /** brief = a conversation about the parked brief; request = a ring-in that
   *  recorded an ask for the agent instead of talking to the assistant. */
  kind?: "brief" | "request";
  /** The recorded ask, transcribed. */
  requestText?: string;
  /** Where Telnyx keeps the audio — stored before transcription is attempted,
   *  so a failed transcription still leaves something to listen to. */
  recordingUrl?: string;
  /** Whether this call goes to the team's watcher queue when it finishes. */
  queued?: boolean;
  /** User id of whoever's watcher took it. Set once; queue skips it after. */
  handledBy?: string;
  /** Guards the ledger against a duplicated end-of-call webhook. */
  debited?: boolean;
  conversationId?: string;
  createdAt: number;
  endedAt?: number;
}

const saveCall = (env: Env, callId: string, record: CallRecord) =>
  env.CALLS.put(`call:${callId}`, JSON.stringify(record), {
    expirationTtl: record.queued ? QUEUED_CALL_TTL_SECS : CALL_TTL_SECS,
  });

const loadCall = async (env: Env, callId: string): Promise<CallRecord | null> => {
  const raw = await env.CALLS.get(`call:${callId}`);
  return raw ? (JSON.parse(raw) as CallRecord) : null;
};

/* ---------------------------------------------------------------- identity */

const teamUrl = (env: Env) => `${env.SITE_URL || "https://screenless.sh"}/team`;

/**
 * The user and org behind a verified phone, creating both on first sight —
 * with the free credit — and syncing a confirmed email onto the user row.
 */
async function identify(env: Env, phone: string): Promise<{ user: db.User; org: db.Org }> {
  const settings = await schedule.loadSettings(env, phone);
  const email = settings.emailVerifiedAt && settings.email ? settings.email : undefined;
  return db.ensureUserForPhone(env, phone, email);
}

/**
 * Blocks anything that costs money when the caller's org has no credit left,
 * and says where the money is added. Replaces the old subscription paywall:
 * there is no trial clock any more, only a balance.
 */
async function requireCredit(
  env: Env,
  phone: string,
): Promise<{ user: db.User; org: db.Org } | Response> {
  const { user, org } = await identify(env, phone);
  if (!billing.entitled(env, org)) {
    return json(
      {
        error: "your team is out of screenless credit — an admin can top up on the billing tab",
        balanceCents: org.credit_cents,
        teamUrl: teamUrl(env),
      },
      402,
    );
  }
  return { user, org };
}

/* -------------------------------------------------------------------- auth */

async function authStart(req: Request, env: Env): Promise<Response> {
  const { phone, channel } = (await req.json().catch(() => ({}))) as {
    phone?: string;
    channel?: string;
  };

  if (!isE164(phone)) return fail(400, "phone must be E.164, e.g. +31612345678");
  if (!destinationAllowed(phone, env.ALLOWED_DESTINATIONS))
    return fail(
      403,
      "we can't call that country yet — mail hello@screenless.sh and we'll add it",
    );
  if (!(await rateLimit(env, `otp:${phone}`, OTP_RATE_LIMIT)))
    return fail(429, "too many verification attempts for this number, try again in an hour");

  // Deliberately checked after the per-number limit, so a single retrying user
  // burns their own budget before touching the shared one.
  if (!(await rateLimit(env, "otp:global", OTP_GLOBAL_HOURLY))) {
    console.error("global OTP hourly ceiling hit — possible SMS pumping");
    return fail(429, "verification is temporarily rate limited, try again shortly");
  }
  if (!(await rateLimit(env, `otp:daily:${new Date().toISOString().slice(0, 10)}`, OTP_GLOBAL_DAILY, 86400))) {
    console.error("global OTP daily ceiling hit — possible SMS pumping");
    return fail(429, "verification is temporarily rate limited, try again tomorrow");
  }

  const send = channel === "call" ? telnyx.triggerCallVerification : telnyx.triggerSmsVerification;
  await send(env.TELNYX_API_KEY, phone, env.TELNYX_VERIFY_PROFILE_ID);

  return json({ sent: true, channel: channel === "call" ? "call" : "sms" });
}

async function authVerify(req: Request, env: Env): Promise<Response> {
  const { phone, code } = (await req.json().catch(() => ({}))) as {
    phone?: string;
    code?: string;
  };

  if (!isE164(phone)) return fail(400, "phone must be E.164");
  if (typeof code !== "string" || !/^\d{4,10}$/.test(code)) return fail(400, "invalid code format");

  const ok = await telnyx.checkVerificationCode(
    env.TELNYX_API_KEY,
    phone,
    code,
    env.TELNYX_VERIFY_PROFILE_ID,
  );
  // An expired code arrives here as "rejected" too — same message either way,
  // deliberately, so we do not leak whether the number had a pending code.
  if (!ok) return fail(401, "code rejected or expired");

  // A verified phone is a screenless identity: make sure the user and their
  // org exist, which is also where a first-timer's free credit is granted.
  // Best-effort — a D1 hiccup must not fail a login the OTP already proved.
  await identify(env, phone).catch((err) =>
    console.error("identify on verify failed", (err as Error).message),
  );

  // Deliberately reads nothing: see the note on SessionPayload.iat.
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SESSION_TTL_SECS;
  return json({ token: await sign({ phone, exp, iat }, env.SESSION_SECRET), phone, expiresAt: exp });
}

/* ------------------------------------------------------------------- calls */

/**
 * Settings as the CLI wants them: the stored values plus the two things that
 * are derived from them and awkward to compute on a laptop — the next actual
 * ring time, and the number to ring back on.
 */
function withNextCall(settings: schedule.Settings, env: Env) {
  return {
    ...settings,
    nextCallAt: schedule.nextCallTime(settings),
    inboundNumber: env.TELNYX_FROM_NUMBER,
    // Sent so the CLI never hard-codes a language list that can drift from
    // what the Worker will actually accept.
    languages: LANGUAGES.map((l) => ({ code: l.code, label: l.label })),
  };
}

/**
 * Tears down the per-call assistant and the TeXML app Telnyx created with it.
 * Best-effort: a failure here must never surface to the caller, but skipping
 * the app leaves one orphan per call. A recorded request has neither.
 */
async function cleanupAssistant(env: Env, record: CallRecord): Promise<void> {
  if (record.assistantId) {
    await telnyx.deleteAssistant(env.TELNYX_API_KEY, record.assistantId).catch(() => {});
  }
  if (record.texmlAppId) {
    await telnyx.deleteTexmlApplication(env.TELNYX_API_KEY, record.texmlAppId).catch(() => {});
  }
}

/**
 * Copies the transcript into our own record, then deletes it at Telnyx.
 *
 * Order matters and is the whole point: read, store, delete. Deleting first
 * would honour the retention promise by destroying the thing the caller came
 * for. Best-effort throughout — a transcript we failed to copy is worth more
 * than a call that errors after the fact.
 */
async function captureTranscript(env: Env, callId: string, record: CallRecord): Promise<void> {
  if (!record.assistantId) return; // a recorded request carries its own text
  try {
    const conversationId =
      record.conversationId ??
      (await telnyx.findConversationByAssistant(env.TELNYX_API_KEY, record.assistantId)) ??
      undefined;
    if (!conversationId) return;

    const lines = await telnyx.getTranscript(env.TELNYX_API_KEY, conversationId);
    record.transcript = lines
      .filter((m) => m.text && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: m.role, text: m.text ?? "", at: m.sent_at ?? m.created_at }));
    record.conversationId = conversationId;
    await saveCall(env, callId, record);

    await telnyx.deleteConversation(env.TELNYX_API_KEY, conversationId).catch(() => {});
  } catch (err) {
    console.error("transcript capture failed", callId, (err as Error).message);
  }
}

/* ------------------------------------------------------------ team queue */

const queueKey = (orgId: string) => `orgq:${orgId}`;

async function loadQueue(env: Env, orgId: string): Promise<string[]> {
  const raw = await env.CALLS.get(queueKey(orgId));
  try {
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Puts a finished call where the team's watchers will find it. The queue is an
 * id list; the truth about each call — including whether someone already took
 * it — lives on the call record, so pruning the list is always safe.
 */
async function enqueueOrgCall(env: Env, orgId: string, callId: string): Promise<void> {
  const list = await loadQueue(env, orgId);
  if (!list.includes(callId)) list.push(callId);
  while (list.length > 50) list.shift();
  await env.CALLS.put(queueKey(orgId), JSON.stringify(list), {
    expirationTtl: QUEUED_CALL_TTL_SECS,
  });
}

/**
 * Everything that happens when a call is over, wherever its end was reported
 * from: bill the org for the minutes, and hand the call to the watchers.
 * Idempotent — the debit is keyed by call id and the queue dedupes.
 */
async function afterCallEnded(env: Env, callId: string, record: CallRecord): Promise<void> {
  if (record.orgId && record.status === "completed" && !record.debited && record.endedAt) {
    const seconds = Math.max(1, Math.round((record.endedAt - record.createdAt) / 1000));
    const cents = Math.ceil((seconds * db.priceCentsPerMinute(env)) / 60);
    await db
      .debitCall(env, record.orgId, record.userId ?? null, callId, seconds, cents)
      .catch((err) => console.error("debit failed", callId, (err as Error).message));
    record.debited = true;
    await saveCall(env, callId, record);
  }

  if (record.orgId && record.queued && record.status === "completed" && !record.voicemail) {
    await enqueueOrgCall(env, record.orgId, callId);
  }
}

type Lang = string;

const asLang = (v: unknown): Lang => (isSupportedLanguage(v) ? v : DEFAULT_LANGUAGE);

/**
 * Everything the assistant is told, from the brief the loop wrote.
 *
 * The boundary this paragraph draws is the whole architecture: the assistant
 * on the phone decides nothing and touches nothing. It collects decisions and
 * hangs up, and the loop on the user's own machine — which has their MCPs,
 * their credentials and their browser — is what acts on the transcript
 * afterwards. Saying so in the prompt keeps the model from promising to "go
 * ahead and merge that", which it otherwise cheerfully does.
 */
const instructionsFor = (prompt: string): string =>
  `${prompt}

## How to hold this conversation
This is a phone call at breakfast, not a status report. The caller has not seen
any of this yet, and the brief above is ordered hardest first, so the first
thing you say about an item must not be the question.

- **Context first, then check, then ask.** For each item: say in two or three
  sentences what it is and why it is on the call, then stop and ask whether
  that is clear or whether they want more before you go on. Only when they say
  they have it do you put the decision, as one question with named options.
- **Short turns.** Never more than three sentences before you pause for them.
  If you notice yourself listing, stop and ask.
- **Answer from the brief.** The background under each item is there so you can
  answer "what else reads it", "who asked for this", "what happens if we don't".
  Use it. If the answer is not in the brief, say so plainly — "that is not in
  my notes" — and offer to mark it for their eyes. Never invent a detail.
- **Let them steer.** If they ask a question, answer it before moving on. If
  they want to skip an item, skip it and say their agent will leave it alone. If
  they are done, wrap up; do not press for the remaining items.
- **Confirm what you heard** in their words, briefly, before the next item. A
  misheard decision is worse than no decision.
- Speak the caller's language throughout. Say pull request numbers and ticket
  ids only if they ask for them; otherwise use the names in the brief.

## What you can and cannot do
You are on a phone call. You cannot take any action yourself: you cannot merge,
comment, label, close, deploy, or write anything anywhere. You have no tools.
Your job is to make sure the caller understands each item and to collect what
they decide.

Never say or imply that you have done something, or that you will do it. The
transcript of this call is handed back to the caller's own agent afterwards,
and that agent carries out every decision. If asked whether something is done,
say plainly that their agent will apply it after the call.`;

/**
 * Creates the per-call assistant and dials out.
 *
 * Shared by the CLI's blocking `screenless call` and by the cron that places
 * parked briefs, so a scheduled call and an on-demand one are the same call.
 */
async function startCall(
  env: Env,
  phone: string,
  prompt: string,
  lang: Lang,
  origin: string,
  opts: { userId?: string; orgId?: string; queued?: boolean } = {},
): Promise<{ ok: true; callId: string } | { ok: false; status: number; error: string }> {
  const callId = crypto.randomUUID();
  const wToken = await webhookToken(callId, env.SESSION_SECRET);

  const assistant = await telnyx.createAssistant(env.TELNYX_API_KEY, `screenless-${callId}`, {
    instructions: instructionsFor(prompt),
    model: env.ASSISTANT_MODEL,
    voice: env.ASSISTANT_VOICE || languageOf(lang).voice,
    language: lang,
    greeting: languageOf(lang).greeting,
  });

  // Calls MUST go through the assistant's own auto-created TeXML app: its
  // voice_url points at /ai/assistants/{id}/texml, which is what actually
  // drives the conversation.
  const connectionId = assistant.telephony_settings?.default_texml_app_id;
  if (!connectionId) {
    await telnyx.deleteAssistant(env.TELNYX_API_KEY, assistant.id).catch(() => {});
    return { ok: false, status: 502, error: "Telnyx did not return a TeXML app for the assistant" };
  }

  // That app defaults to anchorsite "Latency". Pin it to the configured region
  // so media anchors where we want it — non-fatal if it fails, since a call
  // from the wrong PoP beats no call at all.
  await telnyx.setAnchorsite(env.TELNYX_API_KEY, connectionId, env.TELNYX_ANCHORSITE).catch(() => {});

  const record: CallRecord = {
    phone,
    userId: opts.userId,
    orgId: opts.orgId,
    assistantId: assistant.id,
    texmlAppId: connectionId,
    status: "initiated",
    kind: "brief",
    queued: opts.queued,
    createdAt: Date.now(),
  };
  await saveCall(env, callId, record);

  try {
    await telnyx.initiateAiCall(env.TELNYX_API_KEY, connectionId, {
      from: env.TELNYX_FROM_NUMBER,
      // The verified phone, never a value from a request body. This is the
      // property that keeps the PoC from being a dialer.
      to: phone,
      assistantId: assistant.id,
      statusCallback: `${origin}/webhooks/${callId}/status?t=${wToken}`,
      conversationCallback: `${origin}/webhooks/${callId}/conversation?t=${wToken}`,
      amdCallback: `${origin}/webhooks/${callId}/amd?t=${wToken}`,
    });
  } catch (err) {
    await cleanupAssistant(env, record);
    await env.CALLS.delete(`call:${callId}`);
    return { ok: false, status: 502, error: `failed to place call: ${(err as Error).message}` };
  }

  // Lets the loop find the transcript of a call it never initiated — the 07:00
  // one it was asleep for.
  await env.CALLS.put(`last:${phone}`, callId, { expirationTtl: CALL_TTL_SECS });

  return { ok: true, callId };
}

async function placeCall(req: Request, env: Env, origin: string): Promise<Response> {
  const s = await session(req, env.SESSION_SECRET, env.CALLS);
  if (!s) return fail(401, "not authenticated — run `screenless setup`");

  const gate = await requireCredit(env, s.phone);
  if (gate instanceof Response) return gate;

  const { prompt, language, at, hold } = (await req.json().catch(() => ({}))) as {
    prompt?: string;
    language?: string;
    at?: string;
    hold?: boolean;
  };
  if (typeof prompt !== "string" || !prompt.trim()) return fail(400, "prompt is required");
  // Three items with enough background to answer questions from is longer
  // than the six-question list this used to cap; the ceiling guards against a
  // pasted diff, not against a real brief.
  if (prompt.length > 12000) return fail(400, "prompt too long (max 12000 chars)");

  const settings = await schedule.loadSettings(env, s.phone);
  const lang = language === undefined ? asLang(settings.language) : asLang(language);

  // Parked rather than placed: the loop finishes at 03:00 and the call is
  // wanted at 07:00, so the Worker holds the brief in between. It is also what
  // the user reaches if they ring in before then.
  //
  // `at` is checked for presence, not truth: a bare `--at` arrives as "" and
  // means "my configured call time". Testing it for truth sent that case down
  // the dial-now path — the one thing a 03:00 loop must never do.
  if (at !== undefined || hold) {
    const parked = await schedule.parkBrief(env, s.phone, { prompt, language: lang, at, hold });
    if (!parked.ok) return fail(400, parked.error);
    return json({
      parked: true,
      dueAt: parked.brief.dueAt,
      callAt: settings.callAt,
      inboundNumber: env.TELNYX_FROM_NUMBER,
    });
  }

  if (!(await rateLimit(env, `call:${s.phone}`, 20)))
    return fail(429, "call limit reached for this number, try again in an hour");

  // Not queued: this CLI process is already blocking on the transcript, so
  // handing the call to a watcher too would apply it twice.
  const result = await startCall(env, s.phone, prompt, lang, origin, {
    userId: gate.user.id,
    orgId: gate.org.id,
    queued: false,
  });
  if (!result.ok) return fail(result.status, result.error);

  return json({ callId: result.callId, to: s.phone, status: "initiated" });
}

/* ---------------------------------------------------------------- inbound */

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "application/xml" },
  });

const sayXml = (text: string) => `<Say voice="female" language="en-US">${text}</Say>`;
const sayHangup = (text: string) => xml(`${sayXml(text)}<Hangup/>`);

async function inboundToken(req: Request, env: Env): Promise<boolean> {
  const provided = new URL(req.url).searchParams.get("t") ?? "";
  const expected = await webhookToken("inbound", env.SESSION_SECRET);
  return safeEqual(provided, expected);
}

async function inboundBody(req: Request): Promise<Record<string, string>> {
  const body = await req.text();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")]));
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

/**
 * Answers a call *to* our number.
 *
 * Not the assistant — the assistant is who calls *you*. A ring-in gets a plain
 * robot voice: press 1 for the assistant (the parked brief, same conversation
 * you would have got at your call time), or just talk, and the recording is
 * transcribed and routed to whichever teammate's terminal is watching. The
 * caller must be a verified member of a team with credit; both are checked
 * before a second of anyone's time is spent.
 */
async function answerInbound(req: Request, env: Env, origin: string): Promise<Response> {
  if (!(await inboundToken(req, env))) return fail(403, "bad webhook token");

  const params = await inboundBody(req);
  const from = normalizeCallerId(params.From ?? params.from ?? "");
  if (!isE164(from)) return sayHangup("Sorry, I could not read your number. Goodbye.");

  const user = await db.userByPhone(env, from);
  if (!user || !user.phone_verified_at) {
    return sayHangup(
      "This number is not on a screenless team yet. Ask your admin for an invite, or run screenless setup. Goodbye.",
    );
  }
  const org = await db.orgById(env, user.org_id);
  if (!org || !billing.entitled(env, org)) {
    return sayHangup("Your team is out of screenless credit. An admin can top it up on the billing page. Goodbye.");
  }

  const callId = crypto.randomUUID();
  const record: CallRecord = {
    phone: from,
    userId: user.id,
    orgId: org.id,
    assistantId: "",
    status: "answered",
    inbound: true,
    queued: true,
    createdAt: Date.now(),
  };
  await saveCall(env, callId, record);
  await env.CALLS.put(`last:${from}`, callId, { expirationTtl: CALL_TTL_SECS });

  const t = await webhookToken("inbound", env.SESSION_SECRET);
  const choiceUrl = `${origin}/texml/inbound/choice?t=${t}&amp;call=${callId}`;
  const recordUrl = `${origin}/texml/inbound/record?t=${t}&amp;call=${callId}`;

  return xml(
    `<Gather action="${choiceUrl}" method="POST" numDigits="1" timeout="3">` +
      sayXml("screenless. Press 1 to speak to the assistant, or start talking to make your request after the tone.") +
      `</Gather><Redirect method="POST">${recordUrl}</Redirect>`,
  );
}

/** The keypress: 1 connects the parked brief's assistant, anything else records. */
async function inboundChoice(req: Request, env: Env, origin: string): Promise<Response> {
  if (!(await inboundToken(req, env))) return fail(403, "bad webhook token");

  const url = new URL(req.url);
  const callId = url.searchParams.get("call") ?? "";
  const record = await loadCall(env, callId);
  if (!record) return sayHangup("Sorry, something went wrong. Goodbye.");

  const params = await inboundBody(req);
  const t = await webhookToken("inbound", env.SESSION_SECRET);
  const recordUrl = `${origin}/texml/inbound/record?t=${t}&amp;call=${callId}`;
  console.log("inbound choice", callId, `digits=${params.Digits ?? "(none)"}`);

  if ((params.Digits ?? "") === "1") {
    const brief = await schedule.loadBrief(env, record.phone);
    if (!brief) {
      return xml(
        sayXml("There is no briefing waiting for you right now. Tell me what you need after the tone.") +
          `<Redirect method="POST">${recordUrl}</Redirect>`,
      );
    }

    const lang = asLang(brief.language);
    const assistant = await telnyx.createAssistant(env.TELNYX_API_KEY, `screenless-in-${Date.now()}`, {
      instructions: instructionsFor(brief.prompt),
      model: env.ASSISTANT_MODEL,
      voice: env.ASSISTANT_VOICE || languageOf(lang).voice,
      language: lang,
      greeting: languageOf(lang).greeting,
    });

    record.assistantId = assistant.id;
    record.texmlAppId = assistant.telephony_settings?.default_texml_app_id;
    record.kind = "brief";
    await saveCall(env, callId, record);

    // Delivered — so the morning sweep does not ring them about it again.
    brief.status = "placed";
    brief.callId = callId;
    await schedule.saveBrief(env, record.phone, brief);

    return xml(`<Connect><AIAssistant id="${assistant.id}"></AIAssistant></Connect>`);
  }

  return xml(`<Redirect method="POST">${recordUrl}</Redirect>`);
}

async function inboundRecord(req: Request, env: Env, origin: string): Promise<Response> {
  if (!(await inboundToken(req, env))) return fail(403, "bad webhook token");
  const callId = new URL(req.url).searchParams.get("call") ?? "";
  const t = await webhookToken("inbound", env.SESSION_SECRET);
  const doneUrl = `${origin}/texml/inbound/recorded?t=${t}&amp;call=${callId}`;
  // Both callbacks, because they cover different endings. `action` fires when
  // the recording ends inside the call — # pressed, silence, maxLength — and
  // its response is what the caller hears next. `recordingStatusCallback` is
  // the only one that fires on the common ending, hanging up: the action URL
  // is deliberately never requested then (Twilio semantics, which TeXML
  // follows), which is exactly how the first two real ring-ins produced a
  // recording nothing ever collected.
  return xml(
    `<Record action="${doneUrl}" method="POST" maxLength="300" timeout="6" finishOnKey="#" playBeep="true" recordingStatusCallback="${doneUrl}" recordingStatusCallbackMethod="POST"/>` +
      sayXml("I did not catch anything. Goodbye.") +
      `<Hangup/>`,
  );
}

/**
 * The recording is in: transcribe it and make it the call's transcript, so a
 * spoken request and an assistant conversation are the same shape to the
 * watcher that collects them.
 *
 * The common way to end a recording is to hang up — which means the call's
 * hangup status callback races this one and usually wins, closing the call as
 * "nothing said" before the transcription exists. So this handler is the
 * authority for request calls: it stores the recording URL first (a request
 * with audio must never be losable to a transcription hiccup), transcribes,
 * and then *upgrades* an already-closed call back to completed, re-running the
 * end-of-call work — the debit is keyed by call id and the queue dedupes, so
 * running it twice changes nothing.
 */
async function inboundRecorded(req: Request, env: Env): Promise<Response> {
  if (!(await inboundToken(req, env))) return fail(403, "bad webhook token");

  const callId = new URL(req.url).searchParams.get("call") ?? "";
  const record = await loadCall(env, callId);
  if (!record) return sayHangup("Sorry, something went wrong. Goodbye.");

  // Both the action and the recording-status callback point here, and a
  // #-terminated recording triggers both. The second arrival has nothing to
  // add.
  if (record.requestText && record.status === "completed") {
    return sayHangup("Got it. Your team's terminal picks this up next. Goodbye.");
  }

  const params = await inboundBody(req);
  const recordingUrl = params.RecordingUrl ?? params.recording_url ?? "";
  console.log(
    "inbound recorded",
    callId,
    `url=${recordingUrl ? "yes" : "no"}`,
    `duration=${params.RecordingDuration ?? "?"}`,
    `keys=${Object.keys(params).join(",")}`,
  );
  if (!recordingUrl) {
    return sayHangup("Nothing recorded. Call again whenever you are ready. Goodbye.");
  }

  record.kind = "request";
  record.recordingUrl = recordingUrl;
  await saveCall(env, callId, record);

  let text = "";
  try {
    text = await telnyx.transcribeAudio(env.TELNYX_API_KEY, recordingUrl);
  } catch (err) {
    console.error("transcription failed", callId, (err as Error).message);
  }
  record.requestText =
    text || `(the recording could not be transcribed — listen to it at ${recordingUrl})`;
  record.transcript = [{ role: "user", text: record.requestText, at: new Date().toISOString() }];

  if (record.status === "completed" || record.status === "failed") {
    // The hangup already closed this call without its request; reopen and
    // finish it properly now that the request exists.
    record.status = "completed";
    record.endedAt = record.endedAt ?? Date.now();
    await saveCall(env, callId, record);
    await afterCallEnded(env, callId, record);
  } else {
    await saveCall(env, callId, record);
  }

  return sayHangup("Got it. Your team's terminal picks this up next. Goodbye.");
}

/**
 * Closes a ring-in.
 *
 * An outbound call carries its own status callback, minted per call. A
 * ring-in cannot: Telnyx fetches the inbound TeXML before we know anything,
 * so the end of the call arrives on the TeXML *application's* status callback
 * — one URL for every inbound call — and is matched back to the record by the
 * caller's number. The first ring-in ever taken sat at "answered" forever for
 * want of this, and the loop, which only wakes on a finished call, never knew
 * it had happened.
 */
async function finishInbound(env: Env, phone: string, why: string, force = false): Promise<string | null> {
  const callId = await env.CALLS.get(`last:${phone}`);
  if (!callId) return null;
  const record = await loadCall(env, callId);
  if (!record) return null;
  if (record.status === "completed" || record.status === "failed") return null;
  // Only a ring-in is closed from the application-level callback or the
  // sweep; an outbound call has its own per-call status callback. The admin
  // path may force it, for records that predate the flag.
  if (!record.inbound && !force) return null;

  // A ring-in that never got as far as leaving a request or meeting the
  // assistant is a hang-up during the menu: nothing to collect, nothing owed.
  // A request whose transcription is still in flight lands here as failed
  // too — deliberately: the recorded-callback upgrades it to completed the
  // moment the text exists, and until then it must not reach a watcher.
  const substantial = record.assistantId ? true : Boolean(record.requestText);
  record.status = substantial ? "completed" : "failed";
  record.endedAt = Date.now();
  await saveCall(env, callId, record);
  await captureTranscript(env, callId, record);
  await cleanupAssistant(env, record);
  await afterCallEnded(env, callId, record);
  console.log("inbound call finished", callId, why);
  return callId;
}

async function inboundStatus(req: Request, env: Env): Promise<Response> {
  if (!(await inboundToken(req, env))) return fail(403, "bad webhook token");

  const payload = await inboundBody(req);
  const status = String(payload.CallStatus ?? payload.call_status ?? "").toLowerCase();
  if (!["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) return json({ ok: true });
  const from = normalizeCallerId(String(payload.From ?? payload.from ?? ""));
  if (!isE164(from)) return json({ ok: true });
  await finishInbound(env, from, `status ${status}`);
  return json({ ok: true });
}

/**
 * Safety net for a ring-in whose end never reached us — a Worker whose TeXML
 * application has no status callback configured, or a callback that was
 * dropped. Nobody talks to the assistant for an hour; past that, the call is
 * over whatever Telnyx told us.
 */
async function sweepStaleInbound(env: Env): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await env.CALLS.list({ prefix: "call:", cursor, limit: 200 });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const key of page.keys) {
      const raw = await env.CALLS.get(key.name);
      if (!raw) continue;
      const record = JSON.parse(raw) as CallRecord;
      if (!record.inbound || record.status !== "answered") continue;
      if (Date.now() - record.createdAt < 60 * 60 * 1000) continue;
      if (await finishInbound(env, record.phone, "stale sweep")) n += 1;
    }
  } while (cursor);
  return n;
}

function callPayload(callId: string, record: CallRecord) {
  const done = record.status === "completed" || record.status === "failed";
  return {
    callId,
    status: record.status,
    done,
    kind: record.kind ?? "brief",
    ...(record.voicemail ? { voicemail: true } : {}),
    ...(record.requestText ? { requestText: record.requestText } : {}),
    durationSecs: record.endedAt ? Math.round((record.endedAt - record.createdAt) / 1000) : null,
    transcript: done ? record.transcript ?? [] : undefined,
  };
}

async function getCall(callId: string, req: Request, env: Env): Promise<Response> {
  const s = await session(req, env.SESSION_SECRET, env.CALLS);
  if (!s) return fail(401, "not authenticated");

  const record = await loadCall(env, callId);
  if (!record) return fail(404, "unknown call id");
  if (record.phone !== s.phone) return fail(403, "not your call");

  const done = record.status === "completed" || record.status === "failed";
  if (!done) return json({ callId, status: record.status, done: false });

  // Served from our own copy: the Telnyx conversation was deleted when the call
  // ended, so this record is the only transcript that still exists.
  return json(callPayload(callId, record));
}

/* ---------------------------------------------------------------- watchers */

interface WatcherInfo {
  watcherId: string;
  userId: string;
  startedAt: number;
  repo?: string;
}

const watcherKey = (orgId: string, watcherId: string) => `watcher:${orgId}:${watcherId}`;

async function liveWatchers(env: Env, orgId: string): Promise<WatcherInfo[]> {
  const watchers: WatcherInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CALLS.list({ prefix: `watcher:${orgId}:`, cursor, limit: 100 });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const key of page.keys) {
      const raw = await env.CALLS.get(key.name);
      if (!raw) continue;
      try {
        const info = JSON.parse(raw) as Omit<WatcherInfo, "watcherId">;
        watchers.push({ ...info, watcherId: key.name.slice(`watcher:${orgId}:`.length) });
      } catch {
        /* stale junk */
      }
    }
  } while (cursor);
  return watchers;
}

/**
 * Which watcher a call belongs to, decided at poll time against whoever is
 * alive right now: the caller's own terminal first (their earliest, if they
 * have two), any teammate's otherwise. Deciding at poll time rather than at
 * call time is what makes the queue survivable — a call that ends into an
 * empty room is simply assigned to the first watcher that shows up.
 */
function assignee(record: CallRecord, watchers: WatcherInfo[]): WatcherInfo | null {
  if (!watchers.length) return null;
  const byStart = (a: WatcherInfo, b: WatcherInfo) =>
    a.startedAt - b.startedAt || a.watcherId.localeCompare(b.watcherId);
  const own = watchers.filter((w) => w.userId === record.userId).sort(byStart);
  if (own.length) return own[0];
  return [...watchers].sort(byStart)[0];
}

/**
 * The watcher's one poll: registers the heartbeat, then answers "is there a
 * finished call for *this* terminal?". Handled and expired entries are pruned
 * in passing; calls assigned to another live watcher are left for it, so two
 * watchers drain a backlog in parallel without ever taking the same call.
 */
async function watchNext(req: Request, env: Env): Promise<Response> {
  const s = await session(req, env.SESSION_SECRET, env.CALLS);
  if (!s) return fail(401, "not authenticated — run `screenless setup`");
  const { user, org } = await identify(env, s.phone);

  const url = new URL(req.url);
  const watcherId = url.searchParams.get("watcher") ?? "";
  const startedAt = Number(url.searchParams.get("started")) || Date.now();
  const repo = url.searchParams.get("repo") ?? "";
  if (!/^[\w-]{6,64}$/.test(watcherId)) return fail(400, "watcher id required");

  await env.CALLS.put(
    watcherKey(org.id, watcherId),
    JSON.stringify({ userId: user.id, startedAt, repo }),
    { expirationTtl: WATCHER_TTL_SECS },
  );

  const watchers = await liveWatchers(env, org.id);
  // KV lists are eventually consistent; the terminal that just heartbeat must
  // exist in its own view of the room whatever the edge cache says.
  if (!watchers.some((w) => w.watcherId === watcherId)) {
    watchers.push({ watcherId, userId: user.id, startedAt, repo });
  }

  const queue = await loadQueue(env, org.id);
  const keep: string[] = [];
  let found: { callId: string; record: CallRecord } | null = null;

  for (const callId of queue) {
    const record = await loadCall(env, callId);
    if (!record || record.handledBy) continue; // expired or done — prune
    keep.push(callId);
    if (record.status !== "completed") continue;
    if (found) continue;
    const who = assignee(record, watchers);
    if (who && who.watcherId === watcherId) found = { callId, record };
  }

  if (keep.length !== queue.length) {
    await env.CALLS.put(queueKey(org.id), JSON.stringify(keep), {
      expirationTtl: QUEUED_CALL_TTL_SECS,
    });
  }

  if (!found) return json({ ready: false, watchers: watchers.length, queued: keep.length });

  const caller = found.record.userId ? await db.userById(env, found.record.userId) : null;
  return json({
    ready: true,
    watchers: watchers.length,
    queued: keep.length,
    call: {
      ...callPayload(found.callId, found.record),
      caller: {
        name: caller?.name ?? "",
        email: caller?.email ?? null,
        phone: found.record.phone,
        you: caller?.id === user.id,
      },
      createdAt: found.record.createdAt,
    },
  });
}

/** Marks a queued call as taken, so no other watcher ever sees it again. */
async function watchDone(req: Request, env: Env): Promise<Response> {
  const s = await session(req, env.SESSION_SECRET, env.CALLS);
  if (!s) return fail(401, "not authenticated");
  const { user, org } = await identify(env, s.phone);

  const { callId } = (await req.json().catch(() => ({}))) as { callId?: string };
  if (typeof callId !== "string" || !callId) return fail(400, "callId required");

  const record = await loadCall(env, callId);
  if (!record || record.orgId !== org.id) return fail(404, "unknown call id");
  if (!record.handledBy) {
    record.handledBy = user.id;
    await saveCall(env, callId, record);
  }
  const queue = await loadQueue(env, org.id);
  const keep = queue.filter((id) => id !== callId);
  if (keep.length !== queue.length) {
    await env.CALLS.put(queueKey(org.id), JSON.stringify(keep), {
      expirationTtl: QUEUED_CALL_TTL_SECS,
    });
  }
  return json({ ok: true, handledBy: record.handledBy });
}

/* ---------------------------------------------------------------- webhooks */

/** Puts a brief back on the shelf, held, after a call that did not reach a person. */
async function reparkHeld(env: Env, phone: string, callId: string): Promise<void> {
  const brief = await schedule.loadBrief(env, phone);
  if (brief && brief.callId === callId) {
    brief.status = "parked";
    brief.dueAt = null;
    brief.attempts += 1;
    await schedule.saveBrief(env, phone, brief);
  }
}

async function handleWebhook(
  callId: string,
  kind: "status" | "conversation" | "amd",
  req: Request,
  env: Env,
): Promise<Response> {
  const provided = new URL(req.url).searchParams.get("t") ?? "";
  const expected = await webhookToken(callId, env.SESSION_SECRET);
  if (!safeEqual(provided, expected)) return fail(403, "bad webhook token");

  const record = await loadCall(env, callId);
  if (!record) return json({ ok: true }); // call expired; nothing to update

  // Telnyx posts TeXML status callbacks as form-encoded, conversation
  // callbacks as JSON. Accept either without guessing from Content-Type.
  const payload = await inboundBody(req);

  if (kind === "amd") {
    // machine_start | machine_end_beep | machine_end_silence | machine_end_other
    // | fax mean nobody is listening. human, unknown and not_sure all mean
    // carry on: a wrong hang-up on a real person costs more than a briefing
    // read to a machine.
    const answeredBy = String(payload.AnsweredBy ?? payload.answered_by ?? "").toLowerCase();
    if ((answeredBy.startsWith("machine") || answeredBy === "fax") && !record.voicemail) {
      record.voicemail = true;
      record.status = "failed";
      record.endedAt = Date.now();
      await saveCall(env, callId, record);
      await reparkHeld(env, record.phone, callId);
      const accountSid = String(payload.AccountSid ?? "");
      const callSid = String(payload.CallSid ?? "");
      if (accountSid && callSid) {
        await telnyx
          .hangupTexmlCall(env.TELNYX_API_KEY, accountSid, callSid)
          .catch((err) => console.error("voicemail hangup failed", callId, (err as Error).message));
      }
      await cleanupAssistant(env, record);
    }
    return json({ ok: true });
  }

  // A call already judged voicemail is over as far as we are concerned; the
  // status callbacks that follow the hang-up must not revive it as completed.
  if (record.voicemail) return json({ ok: true });

  if (kind === "status") {
    const status = String(payload.CallStatus ?? payload.call_status ?? "").toLowerCase();
    if (status === "completed") {
      record.status = "completed";
      record.endedAt = Date.now();
    } else if (["failed", "busy", "no-answer", "canceled"].includes(status)) {
      record.status = "failed";
      record.endedAt = Date.now();

      // Declining the call is a legitimate answer to "now?", not a lost brief.
      // It goes back on the shelf held rather than rescheduled: we do not ring
      // someone who just pressed decline, we wait for them to ring us.
      await reparkHeld(env, record.phone, callId);
    } else if (status === "in-progress" || status === "answered") {
      record.status = "answered";
    } else if (status === "ringing") {
      record.status = "ringing";
    }
  } else {
    const data = (payload as Record<string, unknown>).data ?? payload;
    const id = (data as Record<string, unknown>).conversation_id ?? (data as Record<string, unknown>).id;
    if (typeof id === "string") record.conversationId = id;
  }

  await saveCall(env, callId, record);

  // Once the call is done and we have the transcript handle, the per-call
  // assistant has served its purpose — and the org gets billed, the queue fed.
  if (record.status === "completed" || record.status === "failed") {
    if (record.status === "completed") await captureTranscript(env, callId, record);
    await cleanupAssistant(env, record);
    await afterCallEnded(env, callId, record);
  }

  return json({ ok: true });
}

/* ------------------------------------------------------------------- admin */

async function createVerifyProfile(req: Request, env: Env): Promise<Response> {
  const secret = req.headers.get("X-Admin-Secret") ?? "";
  if (!env.ADMIN_SECRET || !safeEqual(secret, env.ADMIN_SECRET)) return fail(403, "forbidden");

  const destinations = env.ALLOWED_DESTINATIONS.split(",").map((c) => c.trim()).filter(Boolean);
  const profile = await telnyx.createVerifyProfile(env.TELNYX_API_KEY, destinations);

  return json({
    verifyProfileId: profile.data.id,
    next: `wrangler secret put TELNYX_VERIFY_PROFILE_ID  # paste ${profile.data.id}`,
  });
}

/**
 * The signed voice_url to point TELNYX_FROM_NUMBER at, so the number can be
 * rung back.
 *
 * Handed out rather than configured for you: assigning a number to a TeXML
 * application is a one-off click in the Telnyx portal, and doing it through
 * the API here would mean writing number-management code that runs once and is
 * never exercised again.
 */
async function inboundUrl(req: Request, env: Env, origin: string): Promise<Response> {
  const secret = req.headers.get("X-Admin-Secret") ?? "";
  if (!env.ADMIN_SECRET || !safeEqual(secret, env.ADMIN_SECRET)) return fail(403, "forbidden");

  const token = await webhookToken("inbound", env.SESSION_SECRET);
  return json({
    number: env.TELNYX_FROM_NUMBER,
    voiceUrl: `${origin}/texml/inbound?t=${token}`,
    statusCallbackUrl: `${origin}/webhooks/inbound/status?t=${token}`,
    next:
      "Telnyx portal → Voice → TeXML Applications → (new or existing) → set the " +
      "Voice URL above and POST, set the Status Callback URL above and POST, " +
      "then assign this number to that application.",
  });
}

/* ------------------------------------------------------------------ router */

/**
 * Missing secrets otherwise surface as an opaque WebCrypto error deep inside
 * token verification. Fail loudly at the edge instead, and never echo the
 * values themselves.
 */
function missingConfig(env: Env): string[] {
  const required: Array<keyof Env> = [
    "TELNYX_API_KEY",
    "TELNYX_VERIFY_PROFILE_ID",
    "SESSION_SECRET",
    "TELNYX_FROM_NUMBER",
    "TELNYX_ANCHORSITE",
  ];
  return required.filter((k) => !env[k] || typeof env[k] !== "string");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const path = url.pathname.replace(/\/$/, "");
    const method = req.method.toUpperCase();

    try {
      const missing = missingConfig(env);
      /**
       * TeXML that connects the call to an assistant.
       *
       * This is the same document Telnyx serves at
       * /v2/ai/assistants/{id}/texml, but served by us so the call can be
       * placed through /texml/calls — which works — instead of
       * /texml/ai_calls, which connects and then sits silent.
       */
      if (path === "/texml/assistant") {
        const id = url.searchParams.get("id") ?? "";
        if (!/^assistant-[\w-]+$/.test(id)) return fail(400, "bad assistant id");
        // ?say=1 prepends a plain <Say> before connecting the assistant. It is
        // a diagnostic: hearing the Say and then silence proves the audio path
        // works on that exact leg and isolates the fault to the assistant,
        // inside a single call rather than across two.
        const say =
          url.searchParams.get("say") === "1"
            ? `<Say voice="female" language="en-US">Test line. If you can hear this, audio works. Connecting the assistant now.</Say>`
            : "";
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Connect><AIAssistant id="${id}"></AIAssistant></Connect></Response>`,
          { headers: { "Content-Type": "application/xml" } },
        );
      }

      // Inbound: someone ringing the number back. Telnyx has been seen to use
      // either verb for a voice_url, so accept both.
      if (path === "/texml/inbound" && (method === "POST" || method === "GET"))
        return await answerInbound(req, env, origin);
      if (path === "/texml/inbound/choice" && method === "POST")
        return await inboundChoice(req, env, origin);
      if (path === "/texml/inbound/record" && method === "POST")
        return await inboundRecord(req, env, origin);
      if (path === "/texml/inbound/recorded" && method === "POST")
        return await inboundRecorded(req, env);

      // Diagnostic: plain TeXML with no AI assistant involved. Lets us test the
      // telephony + TTS path in isolation when an assistant call goes silent.
      if (path === "/texml/say") {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="female" language="en-US">This is a plain TeXML test call. If you can hear this, telephony and text to speech are working.</Say><Pause length="2"/><Say>Goodbye.</Say></Response>`,
          { headers: { "Content-Type": "application/xml" } },
        );
      }

      if (method === "GET" && path === "/health")
        return json(missing.length ? { ok: false, missing } : { ok: true }, missing.length ? 503 : 200);

      // /admin/verify-profile is how you obtain TELNYX_VERIFY_PROFILE_ID in the
      // first place, so it must stay reachable while that one is still unset.
      const bootstrapping = path === "/admin/verify-profile";
      const blocking = bootstrapping
        ? missing.filter((k) => k !== "TELNYX_VERIFY_PROFILE_ID" && k !== "SESSION_SECRET")
        : missing;
      if (blocking.length)
        return fail(503, `worker is not configured: missing ${blocking.join(", ")}`);

      // The team page and its API — cookie-auth'd, one page, own module.
      const teamRes = await team.handle(req, env, path, method);
      if (teamRes) return teamRes;

      if (method === "POST" && path === "/auth/start") return await authStart(req, env);
      if (method === "POST" && path === "/auth/verify") return await authVerify(req, env);
      if (method === "POST" && path === "/calls") return await placeCall(req, env, origin);
      if (method === "POST" && path === "/admin/verify-profile")
        return await createVerifyProfile(req, env);
      if (method === "GET" && path === "/admin/inbound-url")
        return await inboundUrl(req, env, origin);

      /* --------------------------------------------------------- watchers */

      if (method === "GET" && path === "/watch/next") return await watchNext(req, env);
      if (method === "POST" && path === "/watch/done") return await watchDone(req, env);

      // Who am I, org-wise. Also what `screenless team` prints before it
      // opens the page.
      if (method === "GET" && path === "/org/me") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        const { user, org } = await identify(env, s.phone);
        const roster = await db.members(env, org.id);
        const watchers = await liveWatchers(env, org.id);
        return json({
          user: { name: user.name, email: user.email, role: user.role, phone: user.phone },
          org: { name: org.name, creditCents: org.credit_cents, members: roster.length },
          watchers: watchers.length,
          teamUrl: teamUrl(env),
          inboundNumber: env.TELNYX_FROM_NUMBER,
        });
      }

      /* --------------------------------------------------------- settings */

      if (path === "/settings" && (method === "GET" || method === "POST")) {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");

        if (method === "POST") {
          const patch = (await req.json().catch(() => ({}))) as schedule.SettingsPatch;
          const result = await schedule.updateSettings(env, s.phone, patch);
          if (!result.ok) return fail(400, result.error);
          return json(withNextCall(result.settings, env));
        }

        return json(withNextCall(await schedule.loadSettings(env, s.phone), env));
      }

      // What is queued, and when it will ring. The loop reads this to decide
      // whether it still has time to park tonight's brief.
      if (method === "GET" && path === "/brief") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        const brief = await schedule.loadBrief(env, s.phone);
        return json(
          brief
            ? {
                queued: true,
                status: brief.status,
                dueAt: brief.dueAt,
                attempts: brief.attempts,
                callId: brief.callId ?? null,
                createdAt: brief.createdAt,
              }
            : { queued: false },
        );
      }

      if (method === "DELETE" && path === "/brief") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        await schedule.clearBrief(env, s.phone);
        return json({ cleared: true });
      }

      // The transcript of whatever call happened last, which for a scheduled
      // call is the only handle the loop ever gets — it was asleep when the
      // call id was minted.
      if (method === "GET" && path === "/calls/latest") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated");
        const latest = await env.CALLS.get(`last:${s.phone}`);
        if (!latest) return fail(404, "no calls yet");

        // `since` is what makes a five-minute poll affordable: the collector
        // asks "anything newer than the one I already acted on?" and almost
        // always gets an empty 204 back. Without it every laptop would pull a
        // full transcript 288 times a day to learn nothing.
        if (url.searchParams.get("since") === latest) return new Response(null, { status: 204 });

        return await getCall(latest, req, env);
      }

      /* ------------------------------------------------------------ email */

      // Confirming an address is what makes the free paper safe to offer: the
      // recipient is bound to the account, so nobody can point our verified
      // sending domain at a stranger's inbox.
      if (method === "POST" && path === "/email/start") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        if (!env.RESEND_API_KEY) return fail(503, "mail is not configured on this Worker");

        const { email } = (await req.json().catch(() => ({}))) as { email?: string };
        if (typeof email !== "string" || !isEmail(email)) return fail(400, "a valid email is required");
        if (!(await rateLimit(env, `email:${s.phone}`, 5)))
          return fail(429, "too many confirmation emails, try again in an hour");

        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
        // Keyed by phone, not by address, so a code cannot be redeemed against
        // an address other than the one it was sent to.
        await env.CALLS.put(`emailcode:${s.phone}`, JSON.stringify({ email, code }), {
          expirationTtl: 900,
        });
        await sendEmailCode(env, email, code);
        return json({ sent: true, email });
      }

      if (method === "POST" && path === "/email/verify") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");

        const { code } = (await req.json().catch(() => ({}))) as { code?: string };
        const raw = await env.CALLS.get(`emailcode:${s.phone}`);
        if (!raw) return fail(410, "no pending confirmation — start again");

        const pending = JSON.parse(raw) as { email: string; code: string };
        if (typeof code !== "string" || !safeEqual(code.trim(), pending.code))
          return fail(401, "that code is not right");

        const result = await schedule.updateSettings(env, s.phone, {
          email: pending.email,
          emailVerifiedAt: Date.now(),
        });
        if (!result.ok) return fail(400, result.error);
        await env.CALLS.delete(`emailcode:${s.phone}`);
        // The confirmed address is also this user's sign-in for the team page.
        await db
          .ensureUserForPhone(env, s.phone, pending.email)
          .catch((err) => console.error("email sync to D1 failed", (err as Error).message));
        return json({ verified: true, email: pending.email });
      }

      // Withdraws every token minted for this number. The CLI deleting its own
      // config file is housekeeping, not revocation.
      if (method === "POST" && path === "/auth/logout") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return json({ revoked: true });
        await revokeSessions(env.CALLS, s.phone);
        return json({ revoked: true });
      }

      /* ---------------------------------------------------------- billing */

      // Stripe signs the raw body, so this must stay ahead of anything that
      // would read the request, and outside the session check — Stripe has no
      // token, only a signature.
      if (method === "POST" && path === "/stripe/webhook")
        return await billing.handleWebhook(req, env);

      // The CLI's view of the money: a balance, not a subscription.
      if (method === "GET" && path === "/billing/status") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        const { user, org } = await identify(env, s.phone);
        return json({
          active: billing.entitled(env, org),
          status: billing.billingEnabled(env) ? "payg" : "unmetered",
          balanceCents: org.credit_cents,
          priceCentsPerMinute: db.priceCentsPerMinute(env),
          isAdmin: user.role === "admin",
          orgName: org.name,
          teamUrl: teamUrl(env),
        });
      }

      const call = path.match(/^\/calls\/([\w-]+)$/);
      if (method === "GET" && call) return await getCall(call[1], req, env);

      // Parks an edition for delivery at wake-up. Same session auth as calls:
      // whoever holds the token gets to mail themselves a PDF, nothing more.
      if (method === "POST" && path === "/mail") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        // Deliberately not gated on credit. The paper is the free surface:
        // it is what someone can have working tonight, and it is what earns
        // the right to sell them the call. The rate limit is the only guard it
        // needs, because a PDF costs a fraction of a phone call.
        if (!(await rateLimit(env, `mail:${s.phone}`, 12)))
          return fail(429, "mail limit reached for this number, try again in an hour");

        const settings = await schedule.loadSettings(env, s.phone);
        if (!settings.emailVerifiedAt || !settings.email)
          return fail(412, "no confirmed email — run `screenless email`");

        const body = await req.json().catch(() => null);
        const result = await scheduleMail(body, env, settings.email);
        return result.ok
          ? json({ id: result.id, sendAt: result.sendAt })
          : fail(result.status, result.error);
      }

      if (method === "POST" && path === "/webhooks/inbound/status") return await inboundStatus(req, env);

      // Ops: close a ring-in by hand when its end never arrived.
      const fin = path.match(/^\/admin\/inbound\/(\+\d+)\/finish$/);
      if (method === "POST" && fin) {
        const secret = req.headers.get("X-Admin-Secret") ?? "";
        if (!env.ADMIN_SECRET || !safeEqual(secret, env.ADMIN_SECRET)) return fail(403, "forbidden");
        const id = await finishInbound(env, fin[1], "admin", true);
        return json({ finished: id });
      }

      const hook = path.match(/^\/webhooks\/([\w-]+)\/(status|conversation|amd)$/);
      if (method === "POST" && hook)
        return await handleWebhook(hook[1], hook[2] as "status" | "conversation" | "amd", req, env);

      return fail(404, "not found");
    } catch (err) {
      if (err instanceof telnyx.TelnyxError) {
        console.error("telnyx error", err.status, err.path, err.body);
        return fail(502, `telnyx: ${err.message}`);
      }
      if (err instanceof billing.StripeError) {
        console.error("stripe error", err.status, err.path, err.message);
        return fail(502, `stripe: ${err.message}`);
      }
      console.error("unhandled", err);
      return fail(500, (err as Error).message ?? "internal error");
    }
  },

  /**
   * Cron sweep for parked briefs. Runs every 5 minutes, which is the
   * resolution a caller actually perceives — a call at 08:03 is a call at
   * eight. Also drains the mail outbox, closes stale ring-ins, and nudges
   * members who joined a day ago and never verified a phone.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.RESEND_API_KEY) {
      const { sent, failed } = await sweepOutbox(env);
      if (sent || failed) console.log(`outbox swept: ${sent} sent, ${failed} failed`);
      await sweepPhoneReminders(env).catch((err) =>
        console.error("phone reminder sweep failed", (err as Error).message),
      );
    }
    await sweepBriefs(env);
    const stale = await sweepStaleInbound(env).catch(() => 0);
    if (stale) console.log(`closed ${stale} stale inbound call(s)`);
  },
};

/** The "please verify your phone" nudge, a day after joining, once ever. */
async function sweepPhoneReminders(env: Env): Promise<void> {
  const due = await db.usersNeedingPhoneReminder(env);
  for (const user of due) {
    // Marked before sending: a reminder that never arrives is annoying once,
    // a reminder loop that fires every five minutes is a spam run.
    await db.markPhoneReminderSent(env, user.id);
    const org = await db.orgById(env, user.org_id);
    if (!org) continue;
    await team
      .sendPhoneReminder(env, user, org)
      .catch((err) => console.error("phone reminder failed", user.id, (err as Error).message));
  }
}

/**
 * Places every brief whose time has come.
 *
 * The five-minute tick is the resolution of the whole product: a call at 07:03
 * is a call at seven. Each brief is marked placed *before* the outcome is
 * known, because the failure that actually costs something here is dialling
 * the same person twice, not missing a tick.
 */
async function sweepBriefs(env: Env): Promise<void> {
  const due = await schedule.dueBriefs(env);
  if (!due.length) return;

  // Cron has no request to take an origin from, so the callback host has to be
  // configured rather than inferred.
  const origin = `https://${env.API_HOST || "screenless.sh"}`;

  for (const { phone, brief } of due) {
    const { user, org } = await identify(env, phone);
    if (!billing.entitled(env, org)) {
      // Not dropped: if they top up tomorrow, tomorrow's brief is what should
      // ring, and this one will have aged out of KV by then anyway.
      console.log(`brief skipped, org out of credit`, phone);
      continue;
    }

    const settings = await schedule.loadSettings(env, phone);
    if (!settings.callEnabled) continue;

    brief.status = "placed";
    brief.attempts += 1;
    await schedule.saveBrief(env, phone, brief);

    // Queued: the loop that parked this brief may be asleep when the call
    // ends, and the team's watcher is the thing that collects it.
    const result = await startCall(env, phone, brief.prompt, asLang(brief.language), origin, {
      userId: user.id,
      orgId: org.id,
      queued: true,
    });

    if (result.ok) {
      brief.callId = result.callId;
      await schedule.saveBrief(env, phone, brief);
      console.log(`brief placed`, phone, result.callId);
    } else {
      // Held rather than retried on the next tick: something is wrong with
      // Telnyx or the account, and re-dialling every five minutes turns one
      // broken morning into a very expensive one.
      brief.status = "parked";
      brief.dueAt = null;
      await schedule.saveBrief(env, phone, brief);
      console.error(`brief failed to place`, phone, result.error);
    }
  }
}
