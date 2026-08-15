import * as telnyx from "./telnyx";
import * as billing from "./billing";
import * as schedule from "./schedule";
import { LANGUAGES, DEFAULT_LANGUAGE, MULTI, isSupportedLanguage, languageOf } from "./languages";
import { session, sign, webhookToken, safeEqual, revokeSessions } from "./auth";
import { scheduleMail, sweepOutbox, sendEmailCode, sendTranscript, isEmail } from "./mail";

export interface Env {
  CALLS: KVNamespace;

  // secrets — set with `wrangler secret put <NAME>`
  TELNYX_API_KEY: string;
  TELNYX_VERIFY_PROFILE_ID: string;
  SESSION_SECRET: string;
  ADMIN_SECRET: string;
  /**
   * Optional. While unset the paywall is inert and every verified number is
   * entitled, which is what keeps `wrangler dev` usable.
   */
  STRIPE_SECRET_KEY: string;
  /** Signing secret for the Stripe webhook endpoint. */
  STRIPE_WEBHOOK_SECRET: string;
  /** Sends the nightly edition. Without it the outbox fills and never drains. */
  RESEND_API_KEY: string;

  // vars — set in wrangler.toml
  TELNYX_FROM_NUMBER: string;
  /**
   * Region to pin each call's media to, e.g. "Amsterdam, Netherlands".
   * Applied to the assistant's auto-created TeXML app, which would otherwise
   * default to "Latency".
   */
  TELNYX_ANCHORSITE: string;
  ASSISTANT_MODEL: string;
  /**
   * Optional override. Normally empty: the voice follows the caller's chosen
   * language, and pinning one here gives every language the same accent.
   */
  ASSISTANT_VOICE: string;
  ALLOWED_DESTINATIONS: string;
  /** Recurring price the trial converts to. Falls back to $99/month if unset. */
  STRIPE_PRICE_ID: string;
  /** Landing page, used for Checkout's success and cancel redirects. */
  SITE_URL: string;
  /** This Worker's own hostname. Cron has no request to infer it from. */
  API_HOST: string;
  /** Envelope sender for the edition. The domain must be verified in Resend. */
  MAIL_FROM: string;
  /** Default recipient, so the nightly loop needs no --to. */
  MAIL_TO: string;
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
  assistantId: string;
  /**
   * Copied off Telnyx once the call ends, so the conversation there can be
   * deleted. Expires with the record, which is what makes the 24-hour
   * retention promise on the privacy page true rather than aspirational.
   */
  transcript?: TranscriptLine[];
  /** The app Telnyx auto-provisioned for this assistant; deleted alongside it. */
  texmlAppId?: string;
  status: "initiated" | "ringing" | "answered" | "completed" | "failed";
  conversationId?: string;
  createdAt: number;
  endedAt?: number;
}

/* ------------------------------------------------------------------ helpers */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fail = (status: number, message: string) => json({ error: message }, status);

/** E.164: leading +, country code, 7–14 more digits. */
const isE164 = (s: unknown): s is string =>
  typeof s === "string" && /^\+[1-9]\d{7,14}$/.test(s);

/**
 * Repairs a caller id arriving in a form-encoded webhook body.
 *
 * `application/x-www-form-urlencoded` decodes `+` as a space, so a `From` of
 * `+31612345678` sent as a literal plus arrives as ` 31612345678` and fails
 * every E.164 check. Providers disagree about whether to percent-encode it, and
 * the cost of guessing wrong is that inbound calls are answered with "I could
 * not read your number" — a failure that only shows up on a real call.
 */
function normalizeCallerId(raw: string): string {
  const trimmed = raw.trim();
  return /^\d{8,15}$/.test(trimmed) ? `+${trimmed}` : trimmed;
}

/**
 * Dialling codes that are blocked regardless of the allowlist.
 *
 * This is a fraud control, not a policy one. SMS pumping works by driving
 * verification traffic at ranges where the carrier shares revenue with the
 * fraudster, so the expensive destinations and the abused ones are the same
 * list. Satellite ranges are here because a single message can cost more than
 * a month of subscription.
 *
 * Everything else on earth is fine: an OTP to a normal mobile is cents, and
 * refusing the world to save them is how you end up with a product only Dutch
 * people can buy.
 */
const BLOCKED_PREFIXES = [
  "+881", "+882", "+883", // satellite and international networks
  "+870",                  // Inmarsat
  "+808",                  // shared-cost international
  "+979",                  // international premium rate
  "+888",                  // OCHA
  // Ranges with a long history of SMS-pumping fraud and high termination fees.
  "+252", "+253", "+257", "+265", "+269", "+290", "+291",
  "+297", "+298", "+299", "+373", "+375",
  "+509", "+590", "+592", "+594", "+596", "+597", "+599",
  "+670", "+672", "+673", "+674", "+675", "+676", "+677",
  "+678", "+679", "+680", "+681", "+682", "+683", "+685",
  "+686", "+687", "+688", "+689", "+690", "+691", "+692",
  "+850", "+963", "+964", "+967", "+98",
];

/**
 * Whether a number may be verified and dialled.
 *
 * `ALLOWED_DESTINATIONS` is "*" for worldwide, or a comma-separated list of
 * ISO country codes to narrow it. The block list applies either way — it is a
 * spend guard, and a spend guard you can switch off in config is decoration.
 */
function destinationAllowed(phone: string, allowed: string): boolean {
  if (BLOCKED_PREFIXES.some((p) => phone.startsWith(p))) return false;

  const list = allowed.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (!list.length || list.includes("*")) return true;

  const prefixes: Record<string, string> = {
    NL: "+31", BE: "+32", DE: "+49", GB: "+44", US: "+1", CA: "+1",
    FR: "+33", ES: "+34", IT: "+39", PT: "+351", IE: "+353", DK: "+45",
    SE: "+46", NO: "+47", PL: "+48", CH: "+41", AT: "+43", AU: "+61",
    NZ: "+64", SG: "+65", JP: "+81", IN: "+91", BR: "+55", ZA: "+27",
  };
  return list.some((c) => prefixes[c] && phone.startsWith(prefixes[c]));
}

async function rateLimit(env: Env, key: string, limit: number, ttl = 3600): Promise<boolean> {
  const k = `rl:${key}`;
  const current = parseInt((await env.CALLS.get(k)) ?? "0", 10);
  if (current >= limit) return false;
  await env.CALLS.put(k, String(current + 1), { expirationTtl: ttl });
  return true;
}

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
 * Blocks anything that costs money to run when the caller has no live
 * subscription, and hands back the link that fixes it.
 *
 * Returns null when the caller may proceed. The 402 carries a checkout URL so
 * the CLI never has to send anyone to a web page to find out how to pay — the
 * paywall is answered in the same terminal that hit it.
 */
async function requireSubscription(env: Env, phone: string): Promise<Response | null> {
  if (!billing.billingEnabled(env)) return null;

  const status = await billing.status(env, phone);
  if (status.active) return null;

  let checkoutUrl: string | undefined;
  try {
    checkoutUrl = (await billing.createCheckout(env, phone, "")).url;
  } catch (err) {
    console.error("checkout for gated request failed", (err as Error).message);
  }

  return json(
    {
      error:
        status.status === "none"
          ? "no subscription — start your 7-day free trial"
          : `subscription is ${status.status}`,
      status: status.status,
      checkoutUrl,
    },
    402,
  );
}

/* -------------------------------------------------------------------- auth */

async function authStart(req: Request, env: Env): Promise<Response> {
  const { phone, channel } = (await req.json().catch(() => ({}))) as {
    phone?: string;
    channel?: string;
  };

  if (!isE164(phone)) return fail(400, "phone must be E.164, e.g. +31612345678");
  if (!destinationAllowed(phone, env.ALLOWED_DESTINATIONS))
    return fail(403, `destination not allowed (ALLOWED_DESTINATIONS=${env.ALLOWED_DESTINATIONS})`);
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

  // Deliberately reads nothing: see the note on SessionPayload.iat.
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SESSION_TTL_SECS;
  return json({ token: await sign({ phone, exp, iat }, env.SESSION_SECRET), phone, expiresAt: exp });
}

/* ------------------------------------------------------------------- calls */

/**
 * Tears down the per-call assistant and the TeXML app Telnyx created with it.
 * Best-effort: a failure here must never surface to the caller, but skipping
 * the app leaves one orphan per call.
 */
async function cleanupAssistant(env: Env, record: CallRecord): Promise<void> {
  await telnyx.deleteAssistant(env.TELNYX_API_KEY, record.assistantId).catch(() => {});
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
    await env.CALLS.put(`call:${callId}`, JSON.stringify(record), { expirationTtl: CALL_TTL_SECS });

    await telnyx.deleteConversation(env.TELNYX_API_KEY, conversationId).catch(() => {});
    await mailTranscript(env, record, callId);
  } catch (err) {
    console.error("transcript capture failed", callId, (err as Error).message);
  }
}

/**
 * Emails the transcript once the call ends.
 *
 * The collector on the user's machine is an optimisation, not the guarantee:
 * it only runs when the laptop is awake, and the transcript is deleted after
 * 24 hours. A laptop left shut over a weekend would otherwise lose a
 * conversation the user actually had. This is the copy that survives that,
 * and it costs one email per call.
 */
async function mailTranscript(env: Env, record: CallRecord, callId: string): Promise<void> {
  if (!env.RESEND_API_KEY || !record.transcript?.length) return;

  const settings = await schedule.loadSettings(env, record.phone);
  if (!settings.emailVerifiedAt || !settings.email) return;

  const body = record.transcript
    .map((l) => `${l.role === "assistant" ? "agent" : "you"}  ${l.text}`)
    .join("\n\n");

  await sendTranscript(env, settings.email, callId, body).catch((err) =>
    console.error("transcript mail failed", callId, (err as Error).message),
  );
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

## What you can and cannot do
You are on a phone call. You cannot take any action yourself: you cannot merge,
comment, label, close, deploy, or write anything anywhere. You have no tools.
Your only job is to walk the caller through the items above, ask for the
decision on each, and make sure you have understood it.

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
    assistantId: assistant.id,
    texmlAppId: connectionId,
    status: "initiated",
    createdAt: Date.now(),
  };
  await env.CALLS.put(`call:${callId}`, JSON.stringify(record), { expirationTtl: CALL_TTL_SECS });

  try {
    await telnyx.initiateAiCall(env.TELNYX_API_KEY, connectionId, {
      from: env.TELNYX_FROM_NUMBER,
      // The verified phone, never a value from a request body. This is the
      // property that keeps the PoC from being a dialer.
      to: phone,
      assistantId: assistant.id,
      statusCallback: `${origin}/webhooks/${callId}/status?t=${wToken}`,
      conversationCallback: `${origin}/webhooks/${callId}/conversation?t=${wToken}`,
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

  const unpaid = await requireSubscription(env, s.phone);
  if (unpaid) return unpaid;

  const { prompt, language, at, hold } = (await req.json().catch(() => ({}))) as {
    prompt?: string;
    language?: string;
    at?: string;
    hold?: boolean;
  };
  if (typeof prompt !== "string" || !prompt.trim()) return fail(400, "prompt is required");
  if (prompt.length > 4000) return fail(400, "prompt too long (max 4000 chars)");

  const settings = await schedule.loadSettings(env, s.phone);
  const lang = language === undefined ? asLang(settings.language) : asLang(language);

  // Parked rather than placed: the loop finishes at 03:00 and the call is
  // wanted at 07:00, so the Worker holds the brief in between. It is also what
  // the user reaches if they ring in before then.
  if (at || hold) {
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

  const result = await startCall(env, s.phone, prompt, lang, origin);
  if (!result.ok) return fail(result.status, result.error);

  return json({ callId: result.callId, to: s.phone, status: "initiated" });
}

/* ---------------------------------------------------------------- inbound */

/**
 * Answers a call *to* our number with the brief already waiting for that
 * caller.
 *
 * This is the "not now, I'll ring you back" path, and it matters more than it
 * looks: an outbound-only service has to be answered on its terms, at its
 * time. Because the brief is stored rather than held in the outbound call, the
 * conversation someone gets at 06:40 by dialling in is the same conversation
 * they would have got at 07:00.
 */
async function answerInbound(req: Request, env: Env): Promise<Response> {
  const provided = new URL(req.url).searchParams.get("t") ?? "";
  const expected = await webhookToken("inbound", env.SESSION_SECRET);
  if (!safeEqual(provided, expected)) return fail(403, "bad webhook token");

  const say = (text: string) =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="female" language="en-US">${text}</Say><Hangup/></Response>`,
      { headers: { "Content-Type": "application/xml" } },
    );

  const body = await req.text();
  const params = new URLSearchParams(body);
  // Telnyx posts TeXML callbacks form-encoded, but accept JSON rather than
  // depend on that.
  let from = params.get("From") ?? "";
  if (!from) {
    try {
      const parsed = JSON.parse(body) as { From?: string; from?: string };
      from = parsed.From ?? parsed.from ?? "";
    } catch {
      /* form-encoded after all, and From really is absent */
    }
  }
  from = normalizeCallerId(from);
  if (!isE164(from)) return say("Sorry, I could not read your number. Goodbye.");

  const brief = await schedule.loadBrief(env, from);
  if (!brief) {
    return say(
      "There is nothing queued for this number right now. Your agent will park a brief tonight. Goodbye.",
    );
  }

  const status = await billing.status(env, from);
  if (!status.active) {
    return say("This number does not have an active subscription. Check your terminal. Goodbye.");
  }

  const lang = asLang(brief.language);
  const assistant = await telnyx.createAssistant(env.TELNYX_API_KEY, `screenless-in-${Date.now()}`, {
    instructions: instructionsFor(brief.prompt),
    model: env.ASSISTANT_MODEL,
    voice: env.ASSISTANT_VOICE || languageOf(lang).voice,
    language: lang,
    greeting: languageOf(lang).greeting,
  });

  const callId = crypto.randomUUID();
  const record: CallRecord = {
    phone: from,
    assistantId: assistant.id,
    texmlAppId: assistant.telephony_settings?.default_texml_app_id,
    status: "answered",
    createdAt: Date.now(),
  };
  await env.CALLS.put(`call:${callId}`, JSON.stringify(record), { expirationTtl: CALL_TTL_SECS });
  await env.CALLS.put(`last:${from}`, callId, { expirationTtl: CALL_TTL_SECS });

  // Delivered — so the 07:00 sweep does not ring them about it again.
  brief.status = "placed";
  brief.callId = callId;
  await schedule.saveBrief(env, from, brief);

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><AIAssistant id="${assistant.id}"></AIAssistant></Connect></Response>`,
    { headers: { "Content-Type": "application/xml" } },
  );
}

async function getCall(callId: string, req: Request, env: Env): Promise<Response> {
  const s = await session(req, env.SESSION_SECRET, env.CALLS);
  if (!s) return fail(401, "not authenticated");

  const raw = await env.CALLS.get(`call:${callId}`);
  if (!raw) return fail(404, "unknown call id");
  const record = JSON.parse(raw) as CallRecord;
  if (record.phone !== s.phone) return fail(403, "not your call");

  const done = record.status === "completed" || record.status === "failed";
  if (!done) return json({ callId, status: record.status, done: false });

  // Served from our own copy: the Telnyx conversation was deleted when the call
  // ended, so this record is the only transcript that still exists.
  return json({
    callId,
    status: record.status,
    done: true,
    durationSecs: record.endedAt ? Math.round((record.endedAt - record.createdAt) / 1000) : null,
    transcript: record.transcript ?? [],
  });
}

/* ---------------------------------------------------------------- webhooks */

async function handleWebhook(
  callId: string,
  kind: "status" | "conversation",
  req: Request,
  env: Env,
): Promise<Response> {
  const provided = new URL(req.url).searchParams.get("t") ?? "";
  const expected = await webhookToken(callId, env.SESSION_SECRET);
  if (!safeEqual(provided, expected)) return fail(403, "bad webhook token");

  const raw = await env.CALLS.get(`call:${callId}`);
  if (!raw) return json({ ok: true }); // call expired; nothing to update
  const record = JSON.parse(raw) as CallRecord;

  // Telnyx posts TeXML status callbacks as form-encoded, conversation
  // callbacks as JSON. Accept either without guessing from Content-Type.
  const body = await req.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(body);
  } catch {
    payload = Object.fromEntries(new URLSearchParams(body));
  }

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
      const brief = await schedule.loadBrief(env, record.phone);
      if (brief && brief.callId === callId) {
        brief.status = "parked";
        brief.dueAt = null;
        brief.attempts += 1;
        await schedule.saveBrief(env, record.phone, brief);
      }
    } else if (status === "in-progress" || status === "answered") {
      record.status = "answered";
    } else if (status === "ringing") {
      record.status = "ringing";
    }
  } else {
    const data = (payload.data ?? payload) as Record<string, unknown>;
    const id = data.conversation_id ?? data.id;
    if (typeof id === "string") record.conversationId = id;
  }

  await env.CALLS.put(`call:${callId}`, JSON.stringify(record), { expirationTtl: CALL_TTL_SECS });

  // Once the call is done and we have the transcript handle, the per-call
  // assistant has served its purpose.
  if (record.status === "completed" || record.status === "failed") {
    if (record.status === "completed") await captureTranscript(env, callId, record);
    await cleanupAssistant(env, record);
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
    next:
      "Telnyx portal → Voice → TeXML Applications → (new or existing) → set the " +
      "Voice URL above and POST, then assign this number to that application.",
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
        return await answerInbound(req, env);

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

      if (method === "POST" && path === "/auth/start") return await authStart(req, env);
      if (method === "POST" && path === "/auth/verify") return await authVerify(req, env);
      if (method === "POST" && path === "/calls") return await placeCall(req, env, origin);
      if (method === "POST" && path === "/admin/verify-profile")
        return await createVerifyProfile(req, env);
      if (method === "GET" && path === "/admin/inbound-url")
        return await inboundUrl(req, env, origin);

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

      if (method === "GET" && path === "/billing/status") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        return json(await billing.status(env, s.phone));
      }

      // Safe to call repeatedly: an already-subscribed caller gets their
      // status back instead of a second Checkout Session.
      if (method === "POST" && path === "/billing/checkout") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        if (!billing.billingEnabled(env)) return fail(503, "billing is not configured");

        const current = await billing.status(env, s.phone);
        if (current.active) return json({ alreadyActive: true, ...current });

        const { url } = await billing.createCheckout(env, s.phone, origin);
        return json({ url });
      }

      // Changing the card, or cancelling, without us holding either.
      if (method === "POST" && path === "/billing/portal") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        const url = await billing.createPortal(env, s.phone);
        return url ? json({ url }) : fail(404, "no subscription to manage");
      }

      const call = path.match(/^\/calls\/([\w-]+)$/);
      if (method === "GET" && call) return await getCall(call[1], req, env);

      // Parks an edition for delivery at wake-up. Same session auth as calls:
      // whoever holds the token gets to mail themselves a PDF, nothing more.
      if (method === "POST" && path === "/mail") {
        const s = await session(req, env.SESSION_SECRET, env.CALLS);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        // Deliberately not behind the paywall. The paper is the free surface:
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

      const hook = path.match(/^\/webhooks\/([\w-]+)\/(status|conversation)$/);
      if (method === "POST" && hook)
        return await handleWebhook(hook[1], hook[2] as "status" | "conversation", req, env);

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
   * eight.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.RESEND_API_KEY) {
      const { sent, failed } = await sweepOutbox(env);
      if (sent || failed) console.log(`outbox swept: ${sent} sent, ${failed} failed`);
    }
    await sweepBriefs(env);
  },
};

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
  const origin = `https://${env.API_HOST || "api.screenless.sh"}`;

  for (const { phone, brief } of due) {
    const entitled = await billing.status(env, phone);
    if (!entitled.active) {
      // Not dropped: if they pay tomorrow, tomorrow's brief is what should
      // ring, and this one will have aged out of KV by then anyway.
      console.log(`brief skipped, subscription ${entitled.status}`, phone);
      continue;
    }

    const settings = await schedule.loadSettings(env, phone);
    if (!settings.callEnabled) continue;

    brief.status = "placed";
    brief.attempts += 1;
    await schedule.saveBrief(env, phone, brief);

    const result = await startCall(env, phone, brief.prompt, asLang(brief.language), origin);

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
