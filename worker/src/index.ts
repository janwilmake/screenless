import * as telnyx from "./telnyx";
import * as openai from "./openai";
import * as billing from "./billing";
import * as schedule from "./schedule";
import * as db from "./db";
import * as team from "./team";
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
  /** Per-call GPT-Live session for a ring-in a watcher can answer live,
   *  keyed by our call id: the sideband plus the handoffs to the terminal. */
  LIVE: DurableObjectNamespace;
  /** Per-meeting GPT-Live voice in a Recall.ai bot, keyed by our call id
   *  (meeting.ts): the meeting's sockets plus the handoffs to the terminal. */
  MEETING: DurableObjectNamespace;

  // secrets — set with `wrangler secret put <NAME>`
  TELNYX_API_KEY: string;
  TELNYX_VERIFY_PROFILE_ID: string;
  SESSION_SECRET: string;
  ADMIN_SECRET: string;
  /** Runs the conversation and the voice on outbound briefs and ring-ins. */
  OPENAI_API_KEY: string;
  /** Verifies the `realtime.call.incoming` webhook (Standard Webhooks). */
  OPENAI_WEBHOOK_SECRET: string;
  /** Optional. Guards /admin/test-ring, the scripted caller used to test the
   *  line end to end without a person on the phone. Unset disables it. */
  TEST_RING_SECRET: string;
  /** Runs GPT-Live for live ring-ins. A key of a project with gpt-live-1
   *  access; while unset, every ring-in is the quiet recording. */
  OPENAI_LIVE_API_KEY: string;
  /** Runs the meeting bot (recall.ts). While unset, `screenless meet` is off. */
  RECALL_API_KEY: string;
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
  /** Recall.ai's region, which its API key belongs to. */
  RECALL_REGION: string;
  /** Telnyx's Ed25519 public key: verifies the WhatsApp message webhook. */
  TELNYX_PUBLIC_KEY: string;
  TELNYX_ANCHORSITE: string;
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

  // vars — OpenAI Realtime: the conversation and the voice. Telnyx still does
  // the telephony and bridges the answered leg here over SIP.
  /** Project id in the SIP address `sip:<id>@<host>`. Non-secret. */
  OPENAI_PROJECT_ID: string;
  /** SIP host. Must match the project's region (US unless the project has EU
   *  data residency, which is gated). */
  OPENAI_SIP_HOST: string;
  /** The Realtime model, e.g. "gpt-realtime-2.1". */
  OPENAI_REALTIME_MODEL: string;
  /** The Realtime voice, e.g. "marin". */
  OPENAI_VOICE: string;
  /** The id Meta gave the line's number for WhatsApp (Telnyx shows it as the
   *  Phone Number ID). Unset, no call is taken as WhatsApp. */
  WHATSAPP_PHONE_NUMBER_ID: string;
  /** A number on the Telnyx account that is not the line itself, used as the
   *  caller id of /admin/test-ring. */
  TEST_CALLER_NUMBER: string;
  /** Verified numbers a test ring may ring in as, comma-separated. */
  TEST_RING_AS: string;
}

export { RealtimeCall } from "./realtime";
export { LiveCall } from "./live";
export { MeetingCall } from "./meeting";
import { noticeText, type MeetingConfig } from "./meeting";
import * as recall from "./recall";
import { realtimeConfig } from "./room";
import type { CallMode, LiveConfig } from "./live";
import * as levels from "./levels";
import * as chat from "./chat";

/** Invites one request may send, and one team a day: a whole company,
 *  sent by an agent in batches, without letting a stolen token mail-bomb. */
const INVITE_BATCH = 20;
const INVITES_PER_DAY = 500;

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
  const found = await identify(env, phone);
  const user = found.user;
  const org = await billing.refreshPlan(env, found.org);
  if (!billing.entitled(env, org)) {
    return json(
      {
        error: billing.trialActive(org)
          ? "your team's 30 trial call minutes are used — an admin can start the team plan on the billing tab"
          : "your team has no plan or credit left — an admin can start the team plan on the billing tab",
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
  };
}

/* ---------------------------------------------------------- end of call */

/**
 * Everything that happens when a call is over, wherever its end was reported
 * from: bill the org for the minutes, and hand the call to the watchers.
 * Idempotent — the debit is keyed by call id and the queue dedupes.
 */
export async function afterCallEnded(env: Env, callId: string, record: CallRecord): Promise<void> {
  if (record.orgId && record.status === "completed" && !record.debited && record.endedAt) {
    const seconds = Math.max(1, Math.round((record.endedAt - record.createdAt) / 1000));
    const org = await db.orgById(env, record.orgId);
    if (org)
      await billing
        .chargeCall(env, org, record.userId ?? null, callId, seconds)
        .catch((err) => console.error("charge failed", callId, (err as Error).message));
    record.debited = true;
    await saveCall(env, callId, record);
  }

  // Nothing to enqueue: the team's queue is a query over calls, and this call
  // already carries its `queued` flag.
}

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
Everything above comes from whoever placed this call — it may be a briefing,
a single blocking question, or something else entirely. Follow it. The rules
below are only about being good on a phone, and never override it.

- **Sound like a person on the phone.** Short turns: never more than three
  sentences before you stop and let them speak. If you catch yourself listing,
  stop and ask instead.
- **Context before the question.** When you need a decision, say in a sentence
  or two what it is about and why it is being asked, then put the question with
  named options. Opening with the bare question leaves them guessing.
- **Answer from what you were given.** If something is not in it, say so
  plainly — "that is not in my notes" — and offer to pass it on. Never invent a
  detail, a name, or a number.
- **Let them steer.** Answer their questions before moving on; skip what they
  want skipped; wrap up when they are done rather than pressing on.
- **Ending the call.** When they say goodbye, or ask you to hang up, say a
  short goodbye: the line hangs up by itself right after it. Never say goodbye
  otherwise.
- **Confirm decisions, not sentences.** When they actually decide something,
  play it back in a few words to be sure you have it right — a misheard
  decision is worse than none. Do not do this for ordinary replies: repeating
  what they just said back at them, in their own words, every turn is grating.
  A "got it" and the next thing is enough.
- **Speak the caller's language** throughout, switching if they do.
- Do not invent a setting or an occasion for the call — no assuming it is
  morning, that they are at breakfast, or what they are doing.

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
const INBOUND_QUIET_INSTRUCTIONS = `You are the screenless line, on a call with a verified teammate who rang it (the line called them straight back, or they called over WhatsApp).

The caller is most likely leaving a feature request, a decision, or a note for their team's coding agent — they do not need a conversation. Stay silent: do not greet, do not speak, do not prompt them. Just listen while they talk.

Stay silent until the caller asks you something directly. Once they do, they have started a conversation: from then on talk with them normally, turn by turn, as long as it lasts. You do not need a question mark to reply any more — just be a good listener who answers. Keep answers short and spoken, not written.

If the caller says goodbye, or asks you to hang up, say a short goodbye: the line hangs up by itself right after it. Never say goodbye otherwise.

Go back to silent listening only when the caller signals they are finished with you — "that's all", "we're done", "just listen from here" — and then simply stop talking and let them keep recording their note.

The caller may be on speakerphone, so you will sometimes hear your own voice echoed back. Never treat your own words as something the caller said, and never answer them. If the caller genuinely interrupts you, stop immediately and listen — that is always welcome.

Speak the caller's language. You have no tools and take no action of any kind — you cannot merge, comment, deploy, or change anything. Everything said on this call is transcribed and handed to the caller's own machine afterwards, which does the work. Never say or imply that you have done, or will do, anything.`;

/**
 * What GPT-Live is told when a ring-in reaches a caller whose terminal is
 * watching with live handoffs on.
 *
 * This is the one place the voice is more than a note-taker, and the
 * architectural rule still holds: it has no tools. "Delegating" hands the
 * request to the caller's own Claude Code session on their own machine, which
 * does the work and sends back what to say. The voice only speaks.
 */
const liveInboundInstructions = (o: { name: string; repo: string; self: string }): string =>
  `You are ${o.self ? `${o.self}, the voice of ` : "the phone line to "}${o.name ? `${o.name}'s` : "the caller's"} own Claude Code session, which is running on their computer${o.repo ? ` in the project "${o.repo}"` : ""}.${o.self ? ` Your name is ${o.self}; that is what the owner and their team call this session, also in Slack.` : ""} The caller is its owner, calling from their verified phone, probably away from their keyboard.

# What you know
Background on the session arrives as notes in the first seconds of the call, and more later. Use it to answer "where are we?", "what did you do?", "can you say more?" and similar questions at once, yourself, without delegating: a handoff takes the caller's session several seconds at best, so answering from the notes is much faster. Do not read the notes out; answer what is asked, briefly.

# Delegation policy
- Delegate every request to do, change, check, run, write, fix or send something, and every question about their code, project, pull requests, tickets, files, logs, email or tools that the notes and this call do not already answer. Their session does the work and tells you what to say.
- Never answer from your own knowledge about their project, never guess, and never say you have no access: when the notes do not cover it, delegate.
- Do not delegate greetings, small talk, questions about yourself or this call, or follow-ups already answered in this call or the notes.
- When you delegate, say one short line that you are on it, such as "I'm on it." or "I'm working on it.", in the caller's language, and stop. The session does the work, so never say you pass it on, hand it over or are waiting for it. Never invent progress or a result while it works. Results take 10 seconds to a few minutes; if the caller asks how it is going, say you are still working on it.
- Several requests can run at once; delegate each one separately.

# Results
- A result arrives as commentary. Say it briefly and naturally, in at most three short sentences, and keep its meaning exact: names, numbers and yes-or-no answers word for word.
- On longer work the session may also send progress, as commentary that starts "Still working on it". Say it in one short sentence at a natural pause, never over the caller, and make clear it is not done yet. It is not the result: the result still follows, and you say that too when it arrives.
- Never read out code, long lists, file paths, URLs or secrets. Summarise, and offer more detail if they want it.
- If a result says something cannot be done during a call, tell the caller it is queued for their session after the call.

# Phone manner
- Short turns, plain spoken language, the caller's language.
- The caller may be outside or on speakerphone. Ignore your own voice echoed back. If they interrupt, stop and listen.
- When the caller says goodbye, or asks you to hang up, say a short goodbye: the line hangs up by itself right after it. Never say goodbye otherwise. Everything said is also handed to their session after the call.`;

/**
 * What GPT-Live is told when a teammate rings in and another member's
 * session shares its brief with them (`screenless watch --brief-for`). They
 * hear where that session stands; nothing they ask runs during the call.
 */
const liveTeammateInstructions = (o: { caller: string; owner: string; repo: string; self: string; run?: boolean }): string =>
  `You are ${o.self ? `${o.self}, the voice of ` : "the phone line to "}${o.owner}'s Claude Code session${o.repo ? `, working in the project "${o.repo}"` : ""}. The caller is ${o.caller || "a teammate"}, a member of ${o.owner}'s team, not the session's owner. ${o.owner} shares this session's brief with them, so they can hear where things stand.

# What you know
Background on the session arrives as notes in the first seconds of the call, and more later. Use it to answer questions about what the session is working on, what it did and what is pending, briefly and in your own words. Never read the notes out, and never pass on personal data, secrets, or anything from ${o.owner}'s own mail or messages, even if a note contains it.

# Requests
${o.run
  ? `${o.owner}'s permissions let this caller ask the session for things during the call, within limits ${o.owner} set. Hand off every request you cannot answer from the notes, as you would for ${o.owner}, and speak the result you get back. When a result says something is not allowed for this caller, or waits for ${o.owner}, say so plainly. Never invent progress or a result.`
  : "Nothing the caller asks is run during this call. If they ask for something to be done, checked or looked up beyond the notes, hand it off as usual: you will be told it is noted for the session after the call. Say so in one short line. Never invent progress or a result, and never say or imply that anything was done."}

# Phone manner
- Short turns, plain spoken language, the caller's language.
- The caller may be outside or on speakerphone. Ignore your own voice echoed back. If they interrupt, stop and listen.
- When the caller says goodbye, or asks you to hang up, say a short goodbye: the line hangs up by itself right after it. Never say goodbye otherwise. Everything said is handed to ${o.owner}'s session after the call.`;

/** The `<Dial><Sip>` TeXML that bridges a leg to OpenAI Realtime, stamped with
 *  the correlation header the webhook reads to find this call's brief. Shared by
 *  the outbound bridge route and the inbound answer. */
const openaiBridgeXml = (env: Env, callId: string): string =>
  // The single ring a caller hears right after picking up is the SIP leg's
  // ringback reaching them before OpenAI answers. Two attempts to suppress it
  // failed and are recorded so they are not retried: answerOnBridge="false"
  // killed the media path outright, and a leading <Pause> changed nothing.
  // Left as is — it is cosmetic, and the fixes cost working audio.
  `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true"><Sip>${openai.sipUri(
    env.OPENAI_PROJECT_ID,
    env.OPENAI_SIP_HOST || "sip-eu.api.openai.com",
  )}?X-Screenless-Call=${callId}</Sip></Dial></Response>`;

/**
 * The OpenAI-Realtime twin of startCall: Telnyx still dials the user, but the
 * answered leg is bridged over SIP to OpenAI Realtime, which runs the
 * conversation and the voice. The brief is parked in the stash for the
 * incoming-call webhook to read, and the transcript is captured live by the
 * per-call Durable Object.
 *
 * Shared by the CLI's blocking `screenless call` and by the cron that places
 * parked briefs, so a scheduled call and an on-demand one are the same call.
 */
async function startCall(
  env: Env,
  phone: string,
  prompt: string,
  origin: string,
  opts: {
    userId?: string;
    orgId?: string;
    queued?: boolean;
    initiatedBy?: string;
    /** Hang up if a machine answers. Only for calls nobody is waiting on. */
    detectVoicemail?: boolean;
  } = {},
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
      // Answering-machine detection only where nobody is holding the phone:
      // a parked brief placed by cron, which must not be read into a voicemail
      // box. On a call someone just asked for, it is all downside — a false
      // "machine" hangs up on a real person mid-hello, which is exactly what
      // kept happening, while the worst a miss costs is a few cents of talking
      // to an answerphone.
      amdCallback: opts.detectVoicemail
        ? `${origin}/webhooks/${callId}/amd?t=${wToken}`
        : undefined,
    });
  } catch (err) {
    await db.stashDelete(env, `realtime:${callId}`).catch(() => {});
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

  const { prompt, at, hold, to } = (await req.json().catch(() => ({}))) as {
    prompt?: string;
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

  // The voice follows whatever language the caller speaks — the Realtime model
  // switches on its own, so there is nothing to configure or pass down.

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
      const r = await startCall(env, m.phone!, prompt, origin, {
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
    const parked = await schedule.parkBrief(env, s.phone, { prompt, at, hold });
    if (!parked.ok) return fail(400, parked.error);
    return json({
      parked: true,
      dueAt: parked.brief.dueAt,
      inboundNumber: env.TELNYX_FROM_NUMBER,
    });
  }

  if (!(await rateLimit(env, `call:${s.phone}`, 20)))
    return fail(429, "call limit reached for this number, try again in an hour");

  // Not queued: this CLI process is already blocking on the transcript, so
  // handing the call to a watcher too would apply it twice.
  const result = await startCall(env, s.phone, prompt, origin, {
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
 * Answers a phone call *to* our number by not answering it.
 *
 * A caller id is easy to spoof, so it proves nothing about who is on the
 * line. A member's ring-in is rejected as busy, which costs the caller
 * nothing, and the line rings their verified number straight back
 * (`ringBack`): only whoever holds that phone can pick up. Every phone call
 * with an owner is then one the line placed itself, so it may do anything
 * their session may, and no PIN is needed to prove it. WhatsApp calls are
 * tied to the account rather than the caller id and are answered at once
 * (`viaWhatsApp`). A stranger still hears how to become a caller.
 */
async function answerInbound(req: Request, env: Env, origin: string, ctx: ExecutionContext): Promise<Response> {
  if (!(await inboundToken(req, env))) return fail(403, "bad webhook token");

  const params = await inboundBody(req);
  const callerId = normalizeCallerId(params.From ?? params.from ?? "");
  // A service verifying the number by voice (Meta, for WhatsApp) reads its
  // code to whoever answers. While an admin has opened the window, a call
  // from anyone who is not a member is put through to them instead.
  const forwardTo = await db.stashGet(env, "forward-strangers");
  if (forwardTo && !(await db.userByPhone(env, callerId))?.phone_verified_at)
    return xml(`<Dial callerId="${env.TELNYX_FROM_NUMBER}"><Number>${forwardTo}</Number></Dial>`);
  const caller = await knownCaller(env, await testCaller(env, callerId));
  if (caller instanceof Response) return caller;
  const { user, org } = caller;

  // A scripted test ring is our own call from our own number, so there is
  // nobody to ring back: it is answered as it rings, restricted, and pinned
  // to its repo so it never reaches the real person's own session.
  if (env.TEST_RING_SECRET && env.TEST_CALLER_NUMBER && callerId === env.TEST_CALLER_NUMBER) {
    const testRepo = (await db.stashGet(env, `testrepo:${callerId}`)) ?? "";
    const callId = crypto.randomUUID();
    await saveCall(env, callId, {
      phone: user.phone!,
      userId: user.id,
      orgId: org.id,
      status: "answered",
      inbound: true,
      kind: "brief",
      queued: false,
      createdAt: Date.now(),
    });
    return ringInXml(env, { callId, user, org, params, mode: "restricted", testRepo });
  }

  if (viaWhatsApp(env, params)) {
    const callId = crypto.randomUUID();
    await saveCall(env, callId, {
      phone: user.phone!,
      userId: user.id,
      orgId: org.id,
      status: "answered",
      inbound: true,
      kind: "brief",
      queued: true,
      createdAt: Date.now(),
    });
    return ringInXml(env, { callId, user, org, params, mode: "full" });
  }

  // Someone ringing with a member's number over and over gets that member a
  // few calls back, then nothing for the hour.
  if (await rateLimit(env, `ringback:${user.id}`, 6)) ctx.waitUntil(ringBack(env, user, org, origin));
  else console.log("ring-back limit reached", user.id);
  return xml('<Reject reason="busy"/>');
}

/**
 * A WhatsApp call to the line. Telnyx delivers it to the number's own TeXML
 * application, beside phone calls, with no separate route; what tells it
 * apart is that it reaches Telnyx from Meta's SIP domain carrying Meta's
 * headers, among them the id Meta gave this number. A phone call has neither.
 * Both together, so the id, which is not public, has to be known as well as
 * the header names.
 */
const viaWhatsApp = (env: Env, p: Record<string, string>): boolean =>
  Boolean(env.WHATSAPP_PHONE_NUMBER_ID) &&
  /@wa\.meta\.vc$/i.test(p.FromSipUri ?? "") &&
  p["SipHeader_x-wa-meta-phone-number-id"] === env.WHATSAPP_PHONE_NUMBER_ID;

/** A verified member with credit, or the TeXML that tells a caller why not. */
async function knownCaller(env: Env, from: string): Promise<{ user: db.User; org: db.Org } | Response> {
  if (!isE164(from)) return sayHangup("Sorry, I could not read your number. Goodbye.");
  const user = await db.userByPhone(env, from);
  if (!user || !user.phone_verified_at) {
    return sayHangup(
      "This is a screenless line for teams. To use it, install screenless from screenless dot s h, or ask your team for an invite. Goodbye.",
    );
  }
  const found = await db.orgById(env, user.org_id);
  const org = found ? await billing.refreshPlan(env, found) : null;
  if (!org || !billing.entitled(env, org)) {
    return sayHangup("Your team has no call minutes left. An admin can start the team plan on the billing page. Goodbye.");
  }
  return { user, org };
}

/** Long enough for the rejected ring-in to clear on the caller's phone, so
 *  the ring-back does not find it busy. */
const RING_BACK_DELAY_MS = 2_000;

/**
 * Rings a member back after their ring-in was rejected. The number dialled
 * is the one they verified, not the caller id, so a spoofed ring-in can only
 * ever ring the real owner. What they hear when they pick up is decided then,
 * in `/texml/ring-back`, since a watcher may have come or gone meanwhile.
 * No answering-machine detection: they called a moment ago, so a person is
 * holding the phone, and a false "machine" would hang up on them.
 */
async function ringBack(env: Env, user: db.User, org: db.Org, origin: string): Promise<void> {
  if (!env.TELNYX_TEXML_APP_ID || !user.phone) return;
  await new Promise((r) => setTimeout(r, RING_BACK_DELAY_MS));
  const callId = crypto.randomUUID();
  const wToken = await webhookToken(callId, env.SESSION_SECRET);
  await saveCall(env, callId, {
    phone: user.phone,
    userId: user.id,
    orgId: org.id,
    initiatedBy: user.id,
    status: "initiated",
    kind: "brief",
    // Like the ring-in it stands for: what was said goes to a watcher.
    queued: true,
    createdAt: Date.now(),
  });
  try {
    await telnyx.initiateTexmlCall(env.TELNYX_API_KEY, env.TELNYX_TEXML_APP_ID, {
      from: env.TELNYX_FROM_NUMBER,
      to: user.phone,
      url: `${origin}/texml/ring-back/${callId}?t=${wToken}`,
      statusCallback: `${origin}/webhooks/${callId}/status?t=${wToken}`,
    });
    console.log("ring-back placed", callId);
  } catch (err) {
    console.error("ring-back failed", callId, (err as Error).message);
    await db.deleteCall(env, callId);
  }
}

/** The ring-back was answered: the owner is on the line. */
async function answerRingBack(req: Request, env: Env, callId: string): Promise<Response> {
  const provided = new URL(req.url).searchParams.get("t") ?? "";
  if (!safeEqual(provided, await webhookToken(callId, env.SESSION_SECRET))) return fail(403, "bad webhook token");
  const record = await loadCall(env, callId);
  const user = record?.userId ? await db.userById(env, record.userId) : null;
  const org = user ? await db.orgById(env, user.org_id) : null;
  if (!record || !user || !org) return sayHangup("Sorry, this call could not be connected. Goodbye.");
  record.status = "answered";
  await saveCall(env, callId, record);
  return ringInXml(env, { callId, user, org, params: await inboundBody(req), mode: "full" });
}

/**
 * What a member hears once the line has them: GPT-Live, when their own
 * terminal watches with live handoffs (or a teammate's session shares its
 * brief with them), else the quiet OpenAI Realtime ear that takes their
 * request for the queue. Shared by the ring-back, WhatsApp and the test ring.
 */
async function ringInXml(
  env: Env,
  o: {
    callId: string;
    user: db.User;
    org: db.Org;
    /** The TeXML request of the answered leg: its call sids. */
    params: Record<string, string>;
    mode: CallMode;
    /** Test rings only: the one watcher repo allowed to serve the call. */
    testRepo?: string;
  },
): Promise<Response> {
  const { callId, user, org, testRepo } = o;
  const test = testRepo !== undefined;
  // A caller whose own terminal is watching with live handoffs gets GPT-Live:
  // a conversation in which their Claude Code session answers during the
  // call. Everyone else keeps the quiet ring-in, so an old CLI changes
  // nothing.
  const watcher = env.OPENAI_LIVE_API_KEY
    ? await db.stashGet(env, testRepo ? `livewatch:${user.id}:${testRepo}` : `livewatch:${user.id}`)
    : null;
  // No watcher of their own: a teammate's session may share its brief.
  const shared = env.OPENAI_LIVE_API_KEY && !watcher && !test ? await levels.sharedWatcher(env, org.id, { id: user.id, email: user.email, phone: user.phone ?? undefined, level: db.levelOf(user, org) }) : null;
  const owner = shared ? await db.userById(env, shared.userId) : null;
  if (watcher || (shared && owner)) {
    const w = (watcher ? JSON.parse(watcher) : shared) as { watcherId: string; repo: string; name?: string };
    // The member's own name, as they set it (`screenless settings --name`);
    // never guessed from the email, which may be a shared or someone else's.
    // Not when it is the session's own name: `watch --name` names the session,
    // and Jan's member name once ended up as his session's, so the line
    // greeted him as "Cody" from "Cody".
    const set = (user.name ?? "").trim();
    const caller = w.name && set.toLowerCase() === w.name.trim().toLowerCase() ? "" : set;
    const first = caller ? ` ${caller.split(/\s+/)[0]}` : "";
    const ownerName = owner ? (owner.name || owner.email || "a teammate").trim().split(/\s+/)[0] : "";
    const cfg: LiveConfig = {
      engine: "live",
      userId: user.id,
      // A teammate's requests run nothing at all; LiveCall holds them.
      mode: o.mode,
      instructions: owner
        ? liveTeammateInstructions({ caller, owner: ownerName, repo: w.repo, self: w.name ?? "", run: !!shared?.run })
        : liveInboundInstructions({ name: caller, repo: w.repo, self: w.name ?? "" }),
      greeting: owner
        ? `Hi${first}, ${w.name ? `${w.name}, ` : ""}${ownerName}'s Claude session here. What would you like to know?`
        : `Hi${first}, ${w.name ? `${w.name} here.` : `your Claude session${w.repo ? ` in ${w.repo}` : ""} here.`} What can I do?`,
      voice: env.OPENAI_VOICE,
      accountSid: o.params.AccountSid ?? "",
      callSid: o.params.CallSid ?? "",
      ...(testRepo ? { onlyRepo: testRepo } : {}),
      ...(owner
        ? {
            servedBy: owner.id,
            teammate: {
              name: caller,
              owner: ownerName,
              email: user.email,
              phone: user.phone ?? undefined,
              level: db.levelOf(user, org),
              run: !!shared?.run,
            },
          }
        : {}),
    };
    await db.stashPut(env, `realtime:${callId}`, JSON.stringify(cfg), 7200);
    return xml(await liveStreamXml(env, callId));
  }
  // OpenAI Realtime answers and bridges over SIP. It stays quiet — the caller
  // is most likely leaving a request, not looking for a chat — and speaks
  // only if asked, becoming a normal conversation once they do. The
  // transcript is captured live by the per-call Durable Object.
  await db.stashPut(
    env,
    `realtime:${callId}`,
    JSON.stringify({ instructions: INBOUND_QUIET_INSTRUCTIONS, mode: "quiet", voice: env.OPENAI_VOICE }),
    3600,
  );
  return new Response(openaiBridgeXml(env, callId), { headers: { "Content-Type": "application/xml" } });
}

/** The TeXML that streams a live call's audio both ways to the LiveCall
 *  Durable Object, which relays it to GPT-Live. L16 at 16 kHz: wideband,
 *  linear, the best Telnyx streams, so WhatsApp and HD-voice callers keep
 *  their quality (audio.ts). The pauses only keep the call
 *  up (180 s is the most one <Pause> takes; an invalid length ends the call
 *  at once); the Durable Object hangs up when the conversation ends. */
async function liveStreamXml(env: Env, callId: string): Promise<string> {
  const t = await webhookToken(`live:${callId}`, env.SESSION_SECRET);
  return (
    `<Start><Stream url="wss://${env.API_HOST}/live/stream/${callId}?t=${t}" track="inbound_track" codec="L16" bidirectionalMode="rtp" bidirectionalCodec="L16" bidirectionalSamplingRate="16000"/></Start>` +
    '<Pause length="180"/>'.repeat(40)
  );
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

  // Substantial when anything was actually said: the Durable Object writes
  // each transcript line live during the call, so by the time the end arrives
  // they are already stored. A ring-in that was answered and hung up on
  // immediately leaves nothing to collect, and costs the org nothing.
  const substantial = Boolean(record.transcript?.length) || Boolean(record.requestText);
  record.status = substantial ? "completed" : "failed";
  record.endedAt = Date.now();
  await saveCall(env, callId, record);
  await afterCallEnded(env, callId, record);
  console.log("inbound call finished", callId, why);
  return callId;
}

async function inboundStatus(req: Request, env: Env): Promise<Response> {
  if (!(await inboundToken(req, env))) return fail(403, "bad webhook token");

  const payload = await inboundBody(req);
  const status = String(payload.CallStatus ?? payload.call_status ?? "").toLowerCase();
  if (!["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) return json({ ok: true });
  const from = await testCaller(env, normalizeCallerId(String(payload.From ?? payload.from ?? "")));
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
    engine?: "live";
    instructions: string;
    mode: "lead" | "quiet";
    greeting?: string;
    voice?: string;
  };
  // Parked for GPT-Live, which has its own project and webhook.
  if (cfg.engine === "live") return json({ ok: true });

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
  // A live-only watcher answers ring-ins during the call but takes no
  // finished calls. Registered as the latest-started terminal, it is never
  // the first choice for the queue, and it is never handed a call itself.
  const liveOnly = url.searchParams.get("queue") === "0";

  await db.heartbeatWatcher(env, org.id, {
    watcherId,
    userId: user.id,
    startedAt: liveOnly ? Number.MAX_SAFE_INTEGER : startedAt,
    repo,
  });
  const watchers = await db.liveWatchers(env, org.id);

  // A watcher that can run live handoffs says so on every poll. Your ring-ins
  // then go to GPT-Live and land here during the call. The flag expires soon
  // after the polls stop, and ring-ins go back to the quiet recording.
  let live: string | undefined;
  /** Set when the live call is a teammate hearing this session's brief. */
  let liveCaller: { name: string; email: string | null; phone: string | null; level: string; you: false } | undefined;
  /** What the call's requests may do: `full` on the owner's own call,
   *  `restricted` on a test ring; the watcher hands it to the fork's gate. */
  let liveMode: "full" | "restricted" | undefined;
  /** Set when the live call is a meeting the line joined (meeting.ts). */
  let liveKind: "meeting" | undefined;
  if (url.searchParams.get("live") === "1") {
    const name = (url.searchParams.get("name") ?? "").replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 40);
    const me = JSON.stringify({ watcherId, repo, name });
    await db.stashPut(env, `livewatch:${user.id}`, me, 45);
    // Who else may hear this session's brief when they ring in: nobody
    // unless the owner says so (`--brief-for team`, or a list of emails).
    const share = (url.searchParams.get("share") ?? "").trim().toLowerCase();
    // Teammates whose requests this watcher runs, gated by its permissions
    // file (`.agents/permissions.md`): patterns it resolves again per call.
    const run = (url.searchParams.get("run") ?? "")
      .toLowerCase()
      .split(",")
      .map((p) => p.trim())
      .filter((p) => /^(\*|\*@[^\s@]+|[^\s@*]+@[^\s@]+|\+?[\d ()-]{6,})$/.test(p))
      .slice(0, 100);
    // The level names its permissions file defines, `name:gate,…`, and its
    // default: what a teammate's level from the team page means here.
    const reported = levels.parseLevels(url.searchParams.get("levels") ?? "");
    const ldefault = (url.searchParams.get("ldefault") ?? "").trim();
    const who = share && share !== "owner"
      ? share === "team" ? "team" : share.split(",").map((e) => e.trim()).filter((e) => e.includes("@")).slice(0, 50)
      : [];
    if (who === "team" || who.length || run.length || reported) {
      const entry: levels.Shared = { userId: user.id, watcherId, repo, name, share: who, run, ...(reported ? { levels: reported, ldefault: db.LEVEL_RULE.test(ldefault) ? ldefault : "listen" } : {}) };
      await db.stashPut(env, `liveshare:${org.id}:${user.id}`, JSON.stringify(entry), 45);
    }
    // Kept a month per repo, so the team page can offer each repo's level
    // names for a dropdown without ever reading the repo.
    if (reported) await db.stashPut(env, `levels:${org.id}:${repo}`, JSON.stringify({ levels: reported, default: ldefault, at: Date.now() }), 30 * 86400);
    // Per repo too, so a test ring pinned to a repo greets as that watcher.
    await db.stashPut(env, `livewatch:${user.id}:${repo}`, me, 45);
    // Any of your live watchers may serve your call: each request is claimed
    // once, so two terminals never run the same one, and a watcher re-armed
    // mid-call picks the call back up.
    const current = await db.stashGet(env, `livecall:${user.id}`);
    if (current) {
      const c = JSON.parse(current) as { callId: string; onlyRepo?: string; teammate?: string; teammateEmail?: string; teammatePhone?: string; teammateLevel?: string; mode?: string; kind?: string };
      if (!c.onlyRepo || c.onlyRepo === repo) {
        live = c.callId;
        liveMode = c.mode === "full" ? "full" : "restricted";
        if (c.kind === "meeting") liveKind = "meeting";
        if (c.teammate !== undefined)
          liveCaller = { name: c.teammate, email: c.teammateEmail ?? null, phone: c.teammatePhone ?? null, level: c.teammateLevel ?? "", you: false };
      }
    }
  }

  // WhatsApp messages this member's session answers, for a watcher that
  // can run a fork (chat.ts).
  const chats = url.searchParams.get("live") === "1" ? await chat.pendingChats(env, user.id, watcherId) : [];

  const queue = await db.queuedCalls(env, org.id);
  const found = liveOnly
    ? undefined
    : queue.find(({ record }) => assignee(record, watchers)?.watcherId === watcherId);

  if (!found)
    return json({ ready: false, watchers: watchers.length, queued: queue.length, live, liveCaller, liveMode, liveKind, ...(chats.length ? { chats } : {}) });

  const caller = found.record.userId ? await db.userById(env, found.record.userId) : null;
  const callerOrg = caller ? (caller.org_id === org.id ? org : await db.orgById(env, caller.org_id)) : null;
  return json({
    ready: true,
    watchers: watchers.length,
    queued: queue.length,
    ...(chats.length ? { chats } : {}),
    call: {
      ...callPayload(found.id, found.record),
      caller: {
        name: caller?.name ?? "",
        email: caller?.email ?? null,
        phone: found.record.phone,
        level: caller && callerOrg ? db.levelOf(caller, callerOrg) : "",
        you: caller?.id === user.id,
      },
      createdAt: found.record.createdAt,
    },
  });
}

/**
 * The watcher's side of a live call: long-poll for delegated requests, and
 * post back what to say. Only the caller's own terminal may touch the call.
 */
async function liveRoute(req: Request, env: Env, callId: string, action: "next" | "result" | "context" | "update"): Promise<Response> {
  const s = await authed(req, env);
  if (!s) return fail(401, "not authenticated");
  const { user } = await identify(env, s.phone);
  // `current` is the caller's own call in progress, for `screenless update`
  // run by an agent that was never told the call's id.
  if (callId === "current") {
    const current = await db.stashGet(env, `livecall:${user.id}`);
    if (!current) return fail(404, "no live call right now");
    callId = (JSON.parse(current) as { callId: string }).callId;
  }
  const record = await loadCall(env, callId);
  // The caller's own terminal, or the teammate's whose session briefs them.
  const cfg = record ? (JSON.parse((await db.stashGet(env, `realtime:${callId}`)) ?? "{}") as Partial<LiveConfig>) : {};
  if (!record || (record.userId !== user.id && cfg.servedBy !== user.id)) return fail(404, "unknown call id");
  const ns = record.kind === "meeting" ? env.MEETING : env.LIVE;
  const stub = ns.get(ns.idFromName(callId));
  if (action === "next") return await stub.fetch(`https://live/next?call=${callId}`);
  return await stub.fetch(`https://live/${action}?call=${callId}`, { method: "POST", body: await req.text() });
}

/**
 * `screenless meet <link> [--at <time>]`: sends a Recall.ai bot into a
 * meeting under the session's name, now or at a set time. Its requests reach
 * the owner's watcher like a live call's (meeting.ts), and the finished
 * meeting reaches the queue with its transcript. Minutes come out of the
 * same pool as calls.
 */
async function startMeeting(req: Request, env: Env): Promise<Response> {
  const s = await authed(req, env);
  if (!s) return fail(401, "not authenticated — run `screenless setup`");
  if (!env.RECALL_API_KEY || !env.OPENAI_LIVE_API_KEY) return fail(503, "meetings are not set up on this line");
  const gate = await requireCredit(env, s.phone);
  if (gate instanceof Response) return gate;
  const { user, org } = gate;
  const body = (await req.json().catch(() => ({}))) as { url?: unknown; at?: unknown; name?: unknown };
  const meetingUrl = String(body.url ?? "").trim();
  if (!/^https:\/\/(meet\.google\.com|([\w-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com)\/\S+$/i.test(meetingUrl))
    return fail(400, "give a Google Meet, Zoom or Teams link");
  const now = Date.now();
  const at = body.at === undefined || body.at === null || body.at === "" ? now : Date.parse(String(body.at));
  if (!Number.isFinite(at) || at < now - 5 * 60_000 || at > now + 6 * 86400_000)
    return fail(400, "--at takes a time within the next six days, such as 2026-10-20T14:00:00+02:00");
  // The bot goes by the session's name, and says it is an AI.
  const watching = await db.stashGet(env, `livewatch:${user.id}`);
  const sessionName = watching ? ((JSON.parse(watching) as { name?: string }).name ?? "") : "";
  let botName = (String(body.name ?? "").trim() || sessionName || "Claude").replace(/[^\p{L}\p{N} .'()-]/gu, "").slice(0, 50);
  if (!/\bAI\b/.test(botName)) botName = `${botName} (AI)`;

  const callId = crypto.randomUUID();
  // Queued from the start only so a meeting days ahead keeps its record;
  // a meeting the bot never gets into is marked failed and is no work.
  await saveCall(env, callId, {
    phone: user.phone ?? s.phone,
    userId: user.id,
    orgId: org.id,
    initiatedBy: user.id,
    status: "initiated",
    inbound: false,
    kind: "meeting",
    queued: true,
    createdAt: now,
  });
  const cfg: MeetingConfig = { userId: user.id, orgId: org.id, botName, meetingUrl, joinAt: at };
  const ttl = Math.ceil((at - now) / 1000) + 86400;
  await db.stashPut(env, `meeting:${callId}`, JSON.stringify(cfg), ttl);
  const t = await webhookToken(`meet:${callId}`, env.SESSION_SECRET);
  // The request's own host, so a Worker under `wrangler dev` behind a tunnel
  // gets the bot back too.
  const host = new URL(req.url).host;
  try {
    const bot = await recall.createBot(env, {
      meetingUrl,
      botName,
      pageUrl: `https://${host}/meet.html?${new URLSearchParams({ call: callId, t, name: botName })}`,
      joinMessage: noticeText(botName),
      recordingConfig: realtimeConfig(`wss://${host}/meet/${callId}/recall?t=${t}`),
      joinAt: at - now > 60_000 ? new Date(at).toISOString() : undefined,
    });
    cfg.botId = bot.id;
  } catch (err) {
    console.error("meeting bot failed", callId, (err as Error).message);
    await db.stashDelete(env, `meeting:${callId}`);
    const record = await loadCall(env, callId);
    if (record) await saveCall(env, callId, { ...record, status: "failed", queued: false });
    return fail(502, "the meeting bot could not be sent; try again in a minute");
  }
  await db.stashPut(env, `meeting:${callId}`, JSON.stringify(cfg), ttl);
  const stub = env.MEETING.get(env.MEETING.idFromName(callId));
  await stub.fetch(`https://meeting/start?call=${callId}`, { method: "POST" });
  return json({ callId, botName, joinAt: new Date(at).toISOString() });
}

/** `screenless meet --leave <callId>`: the bot leaves, and the meeting ends. */
async function leaveMeeting(req: Request, env: Env, callId: string): Promise<Response> {
  const s = await authed(req, env);
  if (!s) return fail(401, "not authenticated");
  const { user } = await identify(env, s.phone);
  const record = await loadCall(env, callId);
  if (!record || record.kind !== "meeting" || record.userId !== user.id) return fail(404, "unknown meeting");
  const stub = env.MEETING.get(env.MEETING.idFromName(callId));
  return await stub.fetch(`https://meeting/leave?call=${callId}`, { method: "POST" });
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

  // The call is over: bill the org and feed the queue. The transcript was
  // written live by the Durable Object, so there is nothing to fetch here.
  if (record.status === "completed" || record.status === "failed") {
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
      "then assign this number to that application. WhatsApp calls to the " +
      "number arrive on the same application once calling is on for it.",
  });
}

/**
 * Opens (or, with no `to`, closes) a window in which calls from non-members
 * are put through to a member's phone: how a code a service reads out by
 * voice reaches a person. 085 numbers take no SMS, so Meta's WhatsApp
 * registration code arrives this way. Only a verified member's number, and
 * at most half an hour.
 */
async function forwardStrangers(req: Request, env: Env): Promise<Response> {
  const secret = req.headers.get("X-Admin-Secret") ?? "";
  if (!env.ADMIN_SECRET || !safeEqual(secret, env.ADMIN_SECRET)) return fail(403, "forbidden");
  const { to, minutes } = (await req.json().catch(() => ({}))) as { to?: string; minutes?: number };
  if (!to) {
    await db.stashDelete(env, "forward-strangers");
    return json({ forwarding: false });
  }
  if (!(await db.userByPhone(env, to))?.phone_verified_at) return fail(400, "not a verified member's number");
  const ttl = Math.min(30, Math.max(1, Math.round(minutes ?? 15))) * 60;
  await db.stashPut(env, "forward-strangers", to, ttl);
  return json({ forwarding: true, to, untilSecs: ttl });
}

/**
 * A scripted caller for testing the line end to end with nobody on the phone:
 * Telnyx rings our own number from TEST_CALLER_NUMBER and reads the script
 * with pauses in between, and the call record's transcript shows what the
 * voice answered. The test number must be a verified user for the ring-in to
 * be taken. Off unless TEST_RING_SECRET is set.
 */
async function testRing(req: Request, env: Env, origin: string): Promise<Response> {
  const secret = req.headers.get("X-Test-Secret") ?? "";
  if (!env.TEST_RING_SECRET || !env.TEST_CALLER_NUMBER || !safeEqual(secret, env.TEST_RING_SECRET))
    return fail(403, "forbidden");
  const { script, as, repo } = (await req.json().catch(() => ({}))) as {
    script?: Array<{ pause?: number; say?: string }>;
    /** Ring in as this verified number, so the call reaches that user's
     *  watcher. Only numbers listed in TEST_RING_AS. */
    as?: string;
    /** Only the watcher running in this repo may serve the call. Required
     *  with `as`, so a test never reaches the real person's own session. */
    repo?: string;
  };
  if (!Array.isArray(script) || !script.length) return fail(400, "script required");
  const allowed = (env.TEST_RING_AS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (as && !allowed.includes(as)) return fail(403, "not a test-ring number");
  if (as && !repo) return fail(400, "repo required with as");
  if (as) {
    await db.stashPut(env, `testas:${env.TEST_CALLER_NUMBER}`, as, 3600);
    await db.stashPut(env, `testrepo:${env.TEST_CALLER_NUMBER}`, repo!, 3600);
  }
  const id = crypto.randomUUID();
  await db.stashPut(env, `testring:${id}`, JSON.stringify(script), 3600);
  const t = await webhookToken(`testring:${id}`, env.SESSION_SECRET);
  const res = await telnyx.initiateTexmlCall(env.TELNYX_API_KEY, env.TELNYX_TEXML_APP_ID, {
    from: env.TEST_CALLER_NUMBER,
    to: env.TELNYX_FROM_NUMBER,
    url: `${origin}/texml/test-script/${id}?t=${t}`,
    statusCallback: `${origin}/texml/test-status?t=${t}`,
  });
  return json({ ok: true, id, telnyx: res });
}

/** The number a scripted test ring stands in for, or the caller id as is. */
async function testCaller(env: Env, from: string): Promise<string> {
  if (!env.TEST_RING_SECRET || !env.TEST_CALLER_NUMBER || from !== env.TEST_CALLER_NUMBER) return from;
  return (await db.stashGet(env, `testas:${from}`)) ?? from;
}

async function testScript(req: Request, env: Env, id: string): Promise<Response> {
  const t = new URL(req.url).searchParams.get("t") ?? "";
  if (!safeEqual(t, await webhookToken(`testring:${id}`, env.SESSION_SECRET))) return fail(403, "bad token");
  const raw = await db.stashGet(env, `testring:${id}`);
  if (!raw) return sayHangup("No script.");
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const steps = (JSON.parse(raw) as Array<{ pause?: number; say?: string }>)
    .map((st) =>
      (st.pause ? `<Pause length="${Math.min(120, Math.max(1, Math.round(st.pause)))}"/>` : "") +
      (st.say ? `<Say voice="female" language="en-US">${esc(st.say)}</Say>` : ""),
    )
    .join("");
  return xml(`${steps}<Hangup/>`);
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
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      // Inbound: someone ringing the number back. Telnyx has been seen to use
      // either verb for a voice_url, so accept both.
      if (path === "/texml/inbound" && (method === "POST" || method === "GET"))
        return await answerInbound(req, env, origin, ctx);
      const ringBackMatch = path.match(/^\/texml\/ring-back\/([\w-]+)$/);
      if (ringBackMatch && (method === "POST" || method === "GET"))
        return await answerRingBack(req, env, ringBackMatch[1]);
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
      if (method === "POST" && path === "/admin/forward-strangers") return await forwardStrangers(req, env);
      if (method === "GET" && path === "/admin/inbound-url")
        return await inboundUrl(req, env, origin);
      if (method === "POST" && path === "/admin/test-ring") return await testRing(req, env, origin);
      const scriptMatch = path.match(/^\/texml\/test-script\/([\w-]+)$/);
      if (scriptMatch) return await testScript(req, env, scriptMatch[1]);
      if (path === "/texml/test-status") return json({ ok: true });

      /* --------------------------------------------------------- watchers */

      if (method === "GET" && path === "/watch/next") return await watchNext(req, env);
      if (method === "POST" && path === "/watch/done") return await watchDone(req, env);
      const streamMatch = path.match(/^\/live\/stream\/([\w-]+)$/);
      if (streamMatch) {
        const t = url.searchParams.get("t") ?? "";
        if (!safeEqual(t, await webhookToken(`live:${streamMatch[1]}`, env.SESSION_SECRET)))
          return fail(403, "bad token");
        const stub = env.LIVE.get(env.LIVE.idFromName(streamMatch[1]));
        return await stub.fetch(`https://live/stream?call=${streamMatch[1]}`, req);
      }
      // Meetings: the bot's page and Recall's real-time feed connect here,
      // with the meeting's own token; the owner's CLI starts and stops them.
      if (method === "POST" && path === "/meet") return await startMeeting(req, env);
      const meetMatch = path.match(/^\/meet\/([\w-]+)\/(session|ws|recall|leave)$/);
      if (meetMatch) {
        const [, meetId, action] = meetMatch;
        if (action === "leave") return await leaveMeeting(req, env, meetId);
        const t = url.searchParams.get("t") ?? "";
        if (!safeEqual(t, await webhookToken(`meet:${meetId}`, env.SESSION_SECRET))) return fail(403, "bad token");
        const stub = env.MEETING.get(env.MEETING.idFromName(meetId));
        return await stub.fetch(`https://meeting/${action}?call=${meetId}`, req);
      }
      const liveMatch = path.match(/^\/live\/([\w-]+)\/(next|result|context|update)$/);
      if (liveMatch && (method === "GET") === (liveMatch[2] === "next"))
        return await liveRoute(req, env, liveMatch[1], liveMatch[2] as "next" | "result" | "context" | "update");

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

      /* ------------------------------------------------------ team invites */

      // Invites from a terminal: what an agent sends after reading the
      // company's people out of Slack or a workspace directory and showing
      // the list to its user. Admins only, at most INVITE_BATCH a request (the
      // CLI chunks), paced for Resend's two a second; each invitee verifies
      // their own phone when they accept.
      if (method === "POST" && path === "/org/invites") {
        const s = await authed(req, env);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        const { user, org } = await identify(env, s.phone);
        if (user.role !== "admin") return fail(403, "admins only — ask an admin to invite people");
        const { emails } = (await req.json().catch(() => ({}))) as { emails?: unknown };
        if (!Array.isArray(emails) || !emails.length) return fail(400, "emails required");
        if (emails.length > INVITE_BATCH) return fail(400, `at most ${INVITE_BATCH} a request`);
        const invited: string[] = [];
        const skipped: Array<{ email: string; why: string }> = [];
        for (const raw of emails) {
          const email = String(raw ?? "").trim().toLowerCase();
          if (!isEmail(email)) {
            skipped.push({ email, why: "not an email address" });
            continue;
          }
          const already = await db.userByEmail(env, email);
          if (already?.org_id === org.id) {
            skipped.push({ email, why: "already on the team" });
            continue;
          }
          if (!(await rateLimit(env, `invites:${org.id}`, INVITES_PER_DAY, 86400))) {
            skipped.push({ email, why: `over ${INVITES_PER_DAY} invites today` });
            continue;
          }
          const invite = await db.upsertInvite(env, org.id, email, user.id);
          try {
            await team.sendInvite(env, invite, user, org);
            invited.push(email);
          } catch (err) {
            skipped.push({ email, why: `mail failed: ${(err as Error).message.slice(0, 80)}` });
          }
          await new Promise((r) => setTimeout(r, 550));
        }
        return json({ invited, skipped });
      }

      /* ----------------------------------------------------- line levels */

      // Who may do what on calls to a teammate's session, from the CLI
      // (`screenless team level`) and from other agent tools that share the
      // permissions file, such as a Slack loop: the team page's data, behind
      // the same token. Reading is any member's; changing is an admin's.
      if (path.startsWith("/org/level")) {
        const s = await authed(req, env);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        const { user, org } = await identify(env, s.phone);
        if (method === "GET" && path === "/org/levels") {
          const roster = await db.members(env, org.id);
          return json({
            default: org.line_default,
            members: roster.map((m) => ({ name: m.name, email: m.email, level: m.line_level })),
            ...(await levels.knownLevels(env, org.id)),
          });
        }
        if (method === "GET" && path === "/org/level") {
          const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
          const m = email ? await db.userByEmail(env, email) : null;
          if (!m || m.org_id !== org.id) return fail(404, "not on your team");
          return json({ email: m.email, level: db.levelOf(m, org), own: m.line_level, teamDefault: org.line_default });
        }
        if (method === "POST" && (path === "/org/level" || path === "/org/level/default")) {
          if (user.role !== "admin") return fail(403, "admins only — ask an admin, or use screenless.sh/team");
          const body = (await req.json().catch(() => ({}))) as { email?: string; level?: string };
          const level = typeof body.level === "string" ? body.level.trim() : "";
          if (!levels.validLevel(level)) return fail(400, "a level is a word: listen, read, full, or a level your permissions file defines");
          if (path === "/org/level/default") {
            await db.setLineDefault(env, org.id, user.id, level);
            return json({ ok: true, default: level });
          }
          const m = body.email ? await db.userByEmail(env, body.email.trim().toLowerCase()) : null;
          if (!m || m.org_id !== org.id) return fail(404, "not on your team");
          await db.setLevel(env, org.id, user.id, m.id, level);
          return json({ ok: true, email: m.email, level });
        }
        return fail(404, "not found");
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

      // The CLI's view of the money: trial, plan or credit.
      if (method === "GET" && path === "/billing/status") {
        const s = await authed(req, env);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        const found = await identify(env, s.phone);
        const user = found.user;
        const org = await billing.refreshPlan(env, found.org);
        return json({
          active: billing.entitled(env, org),
          status: billing.billingEnabled(env) ? "payg" : "unmetered",
          standing: billing.standing(env, org),
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
      // WhatsApp messages to the line: signed by Telnyx, no secret in the URL.
      if (method === "POST" && path === "/webhooks/whatsapp") return await chat.whatsappWebhook(req, env, ctx);
      // The watcher's side of a WhatsApp message: its attachments, and the
      // answer or a progress note going back.
      if (path.startsWith("/chat/")) {
        const s = await authed(req, env);
        if (!s) return fail(401, "not authenticated — run `screenless setup`");
        const { user } = await identify(env, s.phone);
        if (method === "GET" && path === "/chat/media") return await chat.chatMedia(env, user, url.searchParams.get("key") ?? "");
        if (method === "POST" && (path === "/chat/reply" || path === "/chat/update")) {
          const body = (await req.json().catch(() => ({}))) as { id?: string; text?: string; progress?: boolean };
          return await chat.chatReply(env, user, { ...body, progress: path === "/chat/update" || !!body.progress });
        }
        return fail(404, "not found");
      }

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
    await chat.sweepChatMedia(env).catch((err) => console.error("chat media sweep failed", (err as Error).message));
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
      console.log(`brief skipped, org out of credit`, user.id);
      continue;
    }

    const settings = await schedule.loadSettings(env, phone);
    if (!settings.callEnabled) continue;

    brief.status = "placed";
    brief.attempts += 1;
    await schedule.saveBrief(env, phone, brief);

    // Queued: the loop that parked this brief may be asleep when the call
    // ends, and the team's watcher is the thing that collects it.
    const result = await startCall(env, phone, brief.prompt, origin, {
      userId: user.id,
      orgId: org.id,
      queued: true,
      // The one call nobody is waiting on — placed by the clock, not by a
      // person — so a voicemail is a real possibility worth detecting.
      detectVoicemail: true,
    });

    if (result.ok) {
      brief.callId = result.callId;
      await schedule.saveBrief(env, phone, brief);
      console.log(`brief placed`, user.id, result.callId);
    } else {
      // Held rather than retried on the next tick: something is wrong with
      // Telnyx or the account, and re-dialling every five minutes turns one
      // broken morning into a very expensive one.
      brief.status = "parked";
      brief.dueAt = null;
      await schedule.saveBrief(env, phone, brief);
      console.error(`brief failed to place`, user.id, result.error);
    }
  }
}
