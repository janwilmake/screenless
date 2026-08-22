import * as telnyx from "./telnyx";
import * as openai from "./openai";
import * as billing from "./billing";
import * as schedule from "./schedule";
import * as db from "./db";
import * as team from "./team";
import { LANGUAGES, DEFAULT_LANGUAGE, isSupportedLanguage, languageOf } from "./languages";
import { session, sign, webhookToken, safeEqual } from "./auth";
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
  /** All state: users, orgs, invites, ledger, calls, briefs, watchers,
   *  outbox, codes and counters. Schema in ../schema.sql. */
  DB: D1Database;
  /** Parked edition PDFs — the one thing too big for a database row. */
  OUTBOX: R2Bucket;
  /** The landing page, served from site/public by the assets binding. */
  ASSETS: Fetcher;

  /** Per-call OpenAI Realtime session, keyed `realtime:<callId>`, so the
   *  incoming-call webhook can find the brief for a leg Telnyx bridged. */
  REALTIME: DurableObjectNamespace;

  // secrets — set with `wrangler secret put <NAME>`
  TELNYX_API_KEY: string;
  TELNYX_VERIFY_PROFILE_ID: string;
  SESSION_SECRET: string;
  ADMIN_SECRET: string;
  /** Runs the conversation and the voice on outbound briefs and ring-ins. */
  OPENAI_API_KEY: string;
  /** Verifies the `realtime.call.incoming` webhook (Standard Webhooks). */
  OPENAI_WEBHOOK_SECRET: string;
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
  /** Optional. Lets the welcome SMS send from a number not already bound to a
   *  Telnyx messaging profile. Omit when the from-number carries its own. */
  TELNYX_MESSAGING_PROFILE_ID: string;
  /** The standing TeXML application (connection) id outbound OpenAI calls are
   *  placed through. The same one the inbound number is assigned to. */
  TELNYX_TEXML_APP_ID: string;
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

  // vars — OpenAI Realtime (the conversation + voice; Telnyx still does telephony)
  /** "openai" routes the conversation through OpenAI Realtime over SIP;
   *  "telnyx" keeps the Telnyx AI Assistant. Lets the cutover be a flip. */
  VOICE_ENGINE: string;
  /** Project id in the SIP address `sip:<id>@<host>`. Non-secret. */
  OPENAI_PROJECT_ID: string;
  /** SIP host, EU to match the Amsterdam anchorsite. */
  OPENAI_SIP_HOST: string;
  /** The Realtime model, e.g. "gpt-realtime-2.1". */
  OPENAI_REALTIME_MODEL: string;
  /** The Realtime voice, e.g. "marin". */
  OPENAI_VOICE: string;
}

export { RealtimeCall } from "./realtime";

/**
 * Sessions last a year.
 *
 * A week was wrong twice over: it expired on exactly the day the trial
 * converted, and it made a background loop re-verify by SMS every Monday. The
 * token is bound to a verified number and can only ever dial that number, so a
 * long life costs little — and `screenless logout` ends it immediately.
 */
const SESSION_TTL_SECS = 365 * 24 * 60 * 60;
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

type CallRecord = db.CallRecord;
const saveCall = (env: Env, callId: string, record: CallRecord) => db.putCall(env, callId, record);
const loadCall = (env: Env, callId: string) => db.getCall(env, callId);

/** A verified CLI session whose tokens have not been revoked since minting. */
async function authed(req: Request, env: Env) {
  const s = await session(req, env.SESSION_SECRET);
  if (!s) return null;
  // A token with no `iat` predates revocation, so any revocation voids it.
  return (s.iat ?? 0) >= (await db.revokedBefore(env, s.phone)) ? s : null;
}

/* ---------------------------------------------------------------- identity */

const teamUrl = (env: Env) => `${env.SITE_URL || "https://screenless.sh"}/team`;

/**
 * The user and org behind a verified phone, created on first sight — with the
 * free credit. The email needs no syncing any more: settings live on the user.
 */
const identify = (env: Env, phone: string) => db.ensureUserForPhone(env, phone);

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
  const firstTime = !(await db.userByPhone(env, phone).catch(() => null));
  await identify(env, phone).catch((err) =>
    console.error("identify on verify failed", (err as Error).message),
  );

  // The one-time welcome text, so the number is saved and the caller knows to
  // ring it. Only on first sight, and best-effort — it needs an SMS-capable
  // number, and a failure here must never break verification.
  if (firstTime) {
    await telnyx
      .sendSms(
        env.TELNYX_API_KEY,
        env.TELNYX_FROM_NUMBER,
        phone,
        "Welcome to screenless. Add me to your contacts and give me a call whenever you're stuck.",
        env.TELNYX_MESSAGING_PROFILE_ID,
      )
      .catch((err) => console.error("welcome sms failed", (err as Error).message));
  }

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

/* ---------------------------------------------------------- end of call */

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

  // Nothing to enqueue: the team's queue is a query over calls, and this call
  // already carries its `queued` flag.
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
 * What an inbound ring-in is told when OpenAI Realtime answers it.
 *
 * The caller is almost always dropping a request for their team's agent, not
 * looking for a chat — so the assistant stays silent and only speaks if it is
 * actually asked something. The no-action rule is the same as everywhere: it
 * collects, it does not do.
 */
const INBOUND_QUIET_INSTRUCTIONS = `You are the screenless line answering an incoming call from a verified teammate.

The caller is most likely leaving a feature request, a decision, or a note for their team's coding agent — they do not need a conversation. Stay silent: do not greet, do not speak, do not prompt them. Just listen while they talk.

Only speak if the caller directly asks you a question. Then answer briefly, from what you know, and stop. If you do not know, say so in one sentence.

Speak the caller's language. You have no tools and take no action of any kind — you cannot merge, comment, deploy, or change anything. Everything said on this call is transcribed and handed to the caller's own machine afterwards, which does the work. Never say or imply that you have done, or will do, anything.`;

/** The `<Dial><Sip>` TeXML that bridges a leg to OpenAI Realtime, stamped with
 *  the correlation header the webhook reads to find this call's brief. Shared by
 *  the outbound bridge route and the inbound answer. */
const openaiBridgeXml = (env: Env, callId: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true"><Sip>${openai.sipUri(
    env.OPENAI_PROJECT_ID,
    env.OPENAI_SIP_HOST || "sip-eu.api.openai.com",
  )}?X-Screenless-Call=${callId}</Sip></Dial></Response>`;

/**
 * The OpenAI-Realtime twin of startCall: Telnyx still dials the user, but the
 * answered leg is bridged over SIP to OpenAI instead of a Telnyx assistant. The
 * brief is parked in the stash for the incoming-call webhook to read; the
 * transcript is captured by the Durable Object. No per-call assistant, so
 * captureTranscript and cleanupAssistant are no-ops on this record.
 */
async function startCallOpenAI(
  env: Env,
  phone: string,
  prompt: string,
  origin: string,
  opts: { userId?: string; orgId?: string; queued?: boolean; initiatedBy?: string },
): Promise<{ ok: true; callId: string } | { ok: false; status: number; error: string }> {
  if (!env.TELNYX_TEXML_APP_ID)
    return { ok: false, status: 503, error: "TELNYX_TEXML_APP_ID not set" };

  const callId = crypto.randomUUID();
  const wToken = await webhookToken(callId, env.SESSION_SECRET);

  await db.stashPut(
    env,
    `realtime:${callId}`,
    JSON.stringify({
      instructions: instructionsFor(prompt),
      mode: "lead",
      greeting:
        "Open the call: greet them warmly, say you are their screenless assistant with a couple of things to run past them, then begin with the first item.",
      voice: env.OPENAI_VOICE,
    }),
    3600,
  );

  const record: CallRecord = {
    phone,
    userId: opts.userId,
    orgId: opts.orgId,
    initiatedBy: opts.initiatedBy ?? opts.userId,
    assistantId: "", // no Telnyx assistant — the DO owns this call's transcript
    status: "initiated",
    kind: "brief",
    queued: opts.queued,
    createdAt: Date.now(),
  };
  await saveCall(env, callId, record);

  try {
    await telnyx.initiateTexmlCall(env.TELNYX_API_KEY, env.TELNYX_TEXML_APP_ID, {
      from: env.TELNYX_FROM_NUMBER,
      to: phone,
      url: `${origin}/texml/openai-bridge/${callId}?t=${wToken}`,
      statusCallback: `${origin}/webhooks/${callId}/status?t=${wToken}`,
      amdCallback: `${origin}/webhooks/${callId}/amd?t=${wToken}`,
    });
  } catch (err) {
    await db.stashDelete(env, `realtime:${callId}`).catch(() => {});
    await db.deleteCall(env, callId);
    return { ok: false, status: 502, error: `failed to place call: ${(err as Error).message}` };
  }

  return { ok: true, callId };
}

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
  opts: { userId?: string; orgId?: string; queued?: boolean; initiatedBy?: string } = {},
): Promise<{ ok: true; callId: string } | { ok: false; status: number; error: string }> {
  // The conversation engine is a flip: OpenAI Realtime over SIP, or the Telnyx
  // assistant. Both dial through Telnyx; only the answered leg differs.
  if (env.VOICE_ENGINE === "openai") return startCallOpenAI(env, phone, prompt, origin, opts);

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
    // A self-call's initiator is the callee; a dispatch names the dispatcher.
    initiatedBy: opts.initiatedBy ?? opts.userId,
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
    await db.deleteCall(env, callId);
    return { ok: false, status: 502, error: `failed to place call: ${(err as Error).message}` };
  }

  return { ok: true, callId };
}

async function placeCall(req: Request, env: Env, origin: string): Promise<Response> {
  const s = await authed(req, env);
  if (!s) return fail(401, "not authenticated — run `screenless setup`");

  const gate = await requireCredit(env, s.phone);
  if (gate instanceof Response) return gate;

  const { prompt, language, at, hold, to } = (await req.json().catch(() => ({}))) as {
    prompt?: string;
    language?: string;
    at?: string;
    hold?: boolean;
    /** Teammate targets: emails, phones, or ["all"]. Absent means call yourself. */
    to?: string[];
  };
  if (typeof prompt !== "string" || !prompt.trim()) return fail(400, "prompt is required");
  // Three items with enough background to answer questions from is longer
  // than the six-question list this used to cap; the ceiling guards against a
  // pasted diff, not against a real brief.
  if (prompt.length > 12000) return fail(400, "prompt too long (max 12000 chars)");

  const settings = await schedule.loadSettings(env, s.phone);
  const lang = language === undefined ? asLang(settings.language) : asLang(language);

  /* ---- calling teammates: any, some, or all ---- */

  // A `to` list turns this from a self-call into a dispatch. Each target must
  // be a verified number on the caller's own team, and each call is queued so
  // its transcript routes to whoever is watching — the initiator does not
  // block on N conversations. This is the tooling the branded skills sit on.
  if (Array.isArray(to) && to.length) {
    const { members, unknown } = await db.resolveTargets(env, gate.org.id, to);
    if (unknown.length)
      return fail(404, `not on your team, or no verified phone: ${unknown.join(", ")}`);
    if (!members.length) return fail(400, "no teammates with a verified phone to call");
    if (!(await rateLimit(env, `dispatch:${s.phone}`, 10)))
      return fail(429, "too many team calls this hour, try again shortly");

    // Not queued: `screenless call` blocks until the transcripts are in, so the
    // initiator collects them by polling — handing them to a watcher too would
    // apply them twice. `initiatedBy` is what lets the initiator read a
    // teammate's call back (getCall checks it). The queue stays for the cron
    // brief and ring-ins, where nobody is waiting.
    const placed: Array<{ callId: string; to: string; name: string }> = [];
    const failed: Array<{ to: string; error: string }> = [];
    for (const m of members) {
      const r = await startCall(env, m.phone!, prompt, lang, origin, {
        userId: m.id,
        orgId: gate.org.id,
        queued: false,
        initiatedBy: gate.user.id,
      });
      if (r.ok) placed.push({ callId: r.callId, to: m.phone!, name: m.name || m.email || m.phone! });
      else failed.push({ to: m.phone!, error: r.error });
    }
    return json({ dispatched: true, placed, failed });
  }

  /* ---- self-call: park, or dial now and block ---- */

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
 * A known caller hears no voice at all — just the record beep, talk, hang up;
 * the transcription lands in the team's watching terminal. The menu this
 * replaced ("press 1 for the assistant") read as friction: the assistant is
 * who calls *you*, and a ring-in is always a request. Only a stranger gets a
 * voice, telling them how to become a caller.
 */
async function answerInbound(req: Request, env: Env, origin: string): Promise<Response> {
  if (!(await inboundToken(req, env))) return fail(403, "bad webhook token");

  const params = await inboundBody(req);
  const from = normalizeCallerId(params.From ?? params.from ?? "");
  if (!isE164(from)) return sayHangup("Sorry, I could not read your number. Goodbye.");

  const user = await db.userByPhone(env, from);
  if (!user || !user.phone_verified_at) {
    return sayHangup(
      "This is a screenless line for teams. To use it, install screenless from screenless dot s h, or ask your team for an invite. Goodbye.",
    );
  }
  const org = await db.orgById(env, user.org_id);
  if (!org || !billing.entitled(env, org)) {
    return sayHangup("Your team is out of screenless credit. An admin can top it up on the billing page. Goodbye.");
  }

  // OpenAI Realtime answers the ring-in and bridges over SIP. It stays quiet —
  // the caller is most likely leaving a request, not looking for a chat — and
  // speaks only if asked. The transcript is captured by the Durable Object.
  if (env.VOICE_ENGINE === "openai") {
    const callId = crypto.randomUUID();
    const record: CallRecord = {
      phone: from,
      userId: user.id,
      orgId: org.id,
      assistantId: "",
      status: "answered",
      inbound: true,
      kind: "brief",
      queued: true,
      createdAt: Date.now(),
    };
    await saveCall(env, callId, record);
    await db.stashPut(
      env,
      `realtime:${callId}`,
      JSON.stringify({ instructions: INBOUND_QUIET_INSTRUCTIONS, mode: "quiet", voice: env.OPENAI_VOICE }),
      3600,
    );
    return new Response(openaiBridgeXml(env, callId), { headers: { "Content-Type": "application/xml" } });
  }

  const callId = crypto.randomUUID();
  const record: CallRecord = {
    phone: from,
    userId: user.id,
    orgId: org.id,
    assistantId: "",
    status: "answered",
    inbound: true,
    kind: "request",
    queued: true,
    createdAt: Date.now(),
  };
  await saveCall(env, callId, record);

  const t = await webhookToken("inbound", env.SESSION_SECRET);
  const doneUrl = `${origin}/texml/inbound/recorded?t=${t}&amp;call=${callId}`;
  // maxLength is the ceiling, not the intended stop: a voice note ends when
  // the caller hangs up, presses #, or falls silent for `timeout` seconds. So
  // it is set to the platform maximum — an hour — to be effectively no limit,
  // rather than a 5-minute cutoff that would truncate a long briefing dump.
  //
  // Both callbacks, because they cover different endings. `action` fires when
  // the recording ends inside the call — # pressed, silence, maxLength — and
  // its response is what the caller hears next. `recordingStatusCallback` is
  // the only one that fires on the common ending, hanging up: the action URL
  // is deliberately never requested then (Twilio semantics, which TeXML
  // follows), which is exactly how the first two real ring-ins produced a
  // recording nothing ever collected.
  return xml(
    `<Record action="${doneUrl}" method="POST" maxLength="3600" timeout="6" finishOnKey="#" playBeep="true" recordingStatusCallback="${doneUrl}" recordingStatusCallbackMethod="POST"/>` +
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
  const latest = await db.latestCallFor(env, phone);
  if (!latest) return null;
  const { id: callId, record } = latest;
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
  // Substantial if a Telnyx assistant was on the line, or a request was
  // recorded, or — for an OpenAI ring-in — the Durable Object captured any
  // transcript. Transcript lines are written live during the call, so by the
  // time the end arrives they are already there.
  const substantial =
    record.assistantId ? true : Boolean(record.requestText) || Boolean(record.transcript?.length);
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
 * The OpenAI Realtime call-lifecycle webhook.
 *
 * Fires when a leg Telnyx bridged over SIP reaches OpenAI. We verify it,
 * correlate it to our own call via the X-Screenless-Call SIP header, accept it
 * with the session config we parked when the call was placed, and hand a
 * Durable Object the control socket so the transcript is captured live.
 * Rejecting is the safe default: no correlation, or no parked config, means we
 * do not know whose call this is and must not run it.
 */
async function openaiWebhook(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  if (!env.OPENAI_WEBHOOK_SECRET) return fail(503, "openai webhook not configured");
  if (!(await openai.verifyWebhook(env.OPENAI_WEBHOOK_SECRET, raw, req.headers)))
    return fail(403, "bad webhook signature");

  let payload: { type?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ok: true });
  }
  // Only the incoming-call event drives anything; acknowledge the rest.
  if (payload.type !== "realtime.call.incoming") return json({ ok: true });

  const incoming = openai.parseIncoming(payload);
  if (!incoming) return json({ ok: true });

  const ourCallId = openai.correlationId(incoming.sipHeaders);
  const stashed = ourCallId ? await db.stashGet(env, `realtime:${ourCallId}`) : null;
  if (!ourCallId || !stashed) {
    await openai.rejectCall(env.OPENAI_API_KEY, incoming.callId);
    console.error("openai webhook: no correlation for call", incoming.callId, ourCallId ?? "(no header)");
    return json({ ok: true });
  }
  const cfg = JSON.parse(stashed) as {
    instructions: string;
    mode: "lead" | "quiet";
    greeting?: string;
    voice?: string;
  };

  try {
    await openai.acceptCall(env.OPENAI_API_KEY, incoming.callId, {
      model: env.OPENAI_REALTIME_MODEL,
      instructions: cfg.instructions,
      voice: cfg.voice || env.OPENAI_VOICE,
      quiet: cfg.mode === "quiet",
    });
  } catch (err) {
    console.error("openai accept failed", ourCallId, (err as Error).message);
    return json({ ok: true });
  }

  const rec = await loadCall(env, ourCallId);
  if (rec) {
    rec.status = "answered";
    // Reuse conversationId to hold the OpenAI call id. captureTranscript is
    // gated on assistantId (empty for an OpenAI call), so the Telnyx transcript
    // path is never taken here — the Durable Object owns this call's transcript.
    rec.conversationId = incoming.callId;
    await saveCall(env, ourCallId, rec);
  }

  // Hand the live control socket to a per-call Durable Object for the
  // transcript. Its fetch returns as soon as the socket is up; it keeps running
  // for the call and persists each line as it lands.
  const stub = env.REALTIME.get(env.REALTIME.idFromName(ourCallId));
  await stub
    .fetch("https://realtime/start", {
      method: "POST",
      body: JSON.stringify({
        ourCallId,
        openaiCallId: incoming.callId,
        mode: cfg.mode,
        greeting: cfg.greeting,
      }),
    })
    .catch((err) => console.error("realtime DO start failed", ourCallId, (err as Error).message));

  await db.stashDelete(env, `realtime:${ourCallId}`).catch(() => {});
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
  for (const { record } of await db.staleInboundCalls(env, Date.now() - 60 * 60 * 1000)) {
    if (await finishInbound(env, record.phone, "stale sweep")) n += 1;
  }
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
  const s = await authed(req, env);
  if (!s) return fail(401, "not authenticated");

  const record = await loadCall(env, callId);
  if (!record) return fail(404, "unknown call id");
  // Your own call, or one you dispatched to a teammate — the initiator polls a
  // teammate's transcript back, which is what makes `screenless call --to`
  // synchronous.
  if (record.phone !== s.phone) {
    const me = await db.userByPhone(env, s.phone);
    if (!me || record.initiatedBy !== me.id) return fail(403, "not your call");
  }

  const done = record.status === "completed" || record.status === "failed";
  if (!done) return json({ callId, status: record.status, done: false });

  // Served from our own copy: the Telnyx conversation was deleted when the call
  // ended, so this record is the only transcript that still exists.
  return json(callPayload(callId, record));
}

/* ---------------------------------------------------------------- watchers */

/**
 * Which watcher a call belongs to, decided at poll time against whoever is
 * alive right now: the caller's own terminal first (their earliest, if they
 * have two), any teammate's otherwise. Deciding at poll time rather than at
 * call time is what makes the queue survivable — a call that ends into an
 * empty room is simply assigned to the first watcher that shows up.
 */
function assignee(record: CallRecord, watchers: db.WatcherInfo[]): db.WatcherInfo | null {
  if (!watchers.length) return null;
  const byStart = (a: db.WatcherInfo, b: db.WatcherInfo) =>
    a.startedAt - b.startedAt || a.watcherId.localeCompare(b.watcherId);
  const own = watchers.filter((w) => w.userId === record.userId).sort(byStart);
  if (own.length) return own[0];
  return [...watchers].sort(byStart)[0];
}

/**
 * The watcher's one poll: registers the heartbeat, then answers "is there a
 * finished call for *this* terminal?". The queue is a query over calls, so
 * there is nothing to prune; calls assigned to another live watcher are left
 * for it, which is how two watchers drain a backlog in parallel without ever
 * taking the same call.
 */
async function watchNext(req: Request, env: Env): Promise<Response> {
  const s = await authed(req, env);
  if (!s) return fail(401, "not authenticated — run `screenless setup`");
  const { user, org } = await identify(env, s.phone);

  const url = new URL(req.url);
  const watcherId = url.searchParams.get("watcher") ?? "";
  const startedAt = Number(url.searchParams.get("started")) || Date.now();
  const repo = url.searchParams.get("repo") ?? "";
  if (!/^[\w-]{6,64}$/.test(watcherId)) return fail(400, "watcher id required");

  await db.heartbeatWatcher(env, org.id, { watcherId, userId: user.id, startedAt, repo });
  const watchers = await db.liveWatchers(env, org.id);

  const queue = await db.queuedCalls(env, org.id);
  const found = queue.find(({ record }) => assignee(record, watchers)?.watcherId === watcherId);

  if (!found) return json({ ready: false, watchers: watchers.length, queued: queue.length });

  const caller = found.record.userId ? await db.userById(env, found.record.userId) : null;
  return json({
    ready: true,
    watchers: watchers.length,
    queued: queue.length,
    call: {
      ...callPayload(found.id, found.record),
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
  const s = await authed(req, env);
  if (!s) return fail(401, "not authenticated");
  const { user, org } = await identify(env, s.phone);

  const { callId } = (await req.json().catch(() => ({}))) as { callId?: string };
  if (typeof callId !== "string" || !callId) return fail(400, "callId required");

  const record = await loadCall(env, callId);
  if (!record || record.orgId !== org.id) return fail(404, "unknown call id");
  await db.markHandled(env, org.id, callId, user.id);
  return json({ ok: true, handledBy: record.handledBy ?? user.id });
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
      if (path === "/texml/inbound/recorded" && method === "POST")
        return await inboundRecorded(req, env);

      // Outbound OpenAI calls fetch this when the leg answers: the SIP bridge
      // to OpenAI, stamped with this call's correlation header.
      const bridge = path.match(/^\/texml\/openai-bridge\/([\w-]+)$/);
      if (bridge && (method === "POST" || method === "GET")) {
        const bid = bridge[1];
        const provided = url.searchParams.get("t") ?? "";
        if (!safeEqual(provided, await webhookToken(bid, env.SESSION_SECRET)))
          return fail(403, "bad webhook token");
        return new Response(openaiBridgeXml(env, bid), {
          headers: { "Content-Type": "application/xml" },
        });
      }

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
        const s = await authed(req, env);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        const { user, org } = await identify(env, s.phone);
        const roster = await db.members(env, org.id);
        const watchers = await db.liveWatchers(env, org.id);
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
        const s = await authed(req, env);
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
        const s = await authed(req, env);
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
        const s = await authed(req, env);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        await schedule.clearBrief(env, s.phone);
        return json({ cleared: true });
      }

      // The transcript of whatever call happened last, which for a scheduled
      // call is the only handle the loop ever gets — it was asleep when the
      // call id was minted.
      if (method === "GET" && path === "/calls/latest") {
        const s = await authed(req, env);
        if (!s) return fail(401, "not authenticated");
        // The old `?since` dedupe protocol died with `screenless collect`:
        // the watcher is the one channel work arrives on now, and this
        // endpoint only serves `screenless transcript`.
        const latest = await db.latestCallFor(env, s.phone);
        if (!latest) return fail(404, "no calls yet");
        return await getCall(latest.id, req, env);
      }

      /* ------------------------------------------------------------ email */

      // Confirming an address is what makes the free paper safe to offer: the
      // recipient is bound to the account, so nobody can point our verified
      // sending domain at a stranger's inbox.
      if (method === "POST" && path === "/email/start") {
        const s = await authed(req, env);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        if (!env.RESEND_API_KEY) return fail(503, "mail is not configured on this Worker");

        const { email } = (await req.json().catch(() => ({}))) as { email?: string };
        if (typeof email !== "string" || !isEmail(email)) return fail(400, "a valid email is required");
        if (!(await rateLimit(env, `email:${s.phone}`, 5)))
          return fail(429, "too many confirmation emails, try again in an hour");

        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
        // Keyed by phone, not by address, so a code cannot be redeemed against
        // an address other than the one it was sent to.
        await db.stashPut(env, `emailcode:${s.phone}`, JSON.stringify({ email, code }), 900);
        await sendEmailCode(env, email, code);
        return json({ sent: true, email });
      }

      if (method === "POST" && path === "/email/verify") {
        const s = await authed(req, env);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");

        const { code } = (await req.json().catch(() => ({}))) as { code?: string };
        const raw = await db.stashGet(env, `emailcode:${s.phone}`);
        if (!raw) return fail(410, "no pending confirmation — start again");

        const pending = JSON.parse(raw) as { email: string; code: string };
        if (typeof code !== "string" || !safeEqual(code.trim(), pending.code))
          return fail(401, "that code is not right");

        const result = await schedule.updateSettings(env, s.phone, {
          email: pending.email,
          emailVerifiedAt: Date.now(),
        });
        if (!result.ok) return fail(400, result.error);
        await db.stashDelete(env, `emailcode:${s.phone}`);
        return json({ verified: true, email: pending.email });
      }

      // Withdraws every token minted for this number. The CLI deleting its own
      // config file is housekeeping, not revocation.
      if (method === "POST" && path === "/auth/logout") {
        const s = await authed(req, env);
        if (!s) return json({ revoked: true });
        await db.revokeTokens(env, s.phone);
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
        const s = await authed(req, env);
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
        const s = await authed(req, env);
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

        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

        // `team: true` mails every member with a verified address — the weekly
        // edition is the team's paper. Each address was proven by a code or an
        // invite click, so this stays a closed list, never an open relay.
        let recipients = [settings.email];
        if (body?.team === true) {
          const { org } = await identify(env, s.phone);
          const roster = await db.members(env, org.id);
          recipients = roster
            .filter((m) => m.email && m.email_verified_at)
            .map((m) => m.email as string);
        }

        const result = await scheduleMail(body, env, recipients);
        return result.ok
          ? json({ id: result.id, sendAt: result.sendAt, recipients: result.recipients })
          : fail(result.status, result.error);
      }

      if (method === "POST" && path === "/webhooks/inbound/status") return await inboundStatus(req, env);

      // OpenAI Realtime call lifecycle (a leg Telnyx bridged over SIP).
      if (method === "POST" && path === "/webhooks/openai/realtime")
        return await openaiWebhook(req, env);

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
    // KV gave TTLs for free; in D1 they are this one broom.
    await db.cleanupExpired(env).catch((err) =>
      console.error("cleanup sweep failed", (err as Error).message),
    );
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
