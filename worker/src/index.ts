import * as telnyx from "./telnyx";
import { session, sign, webhookToken, safeEqual } from "./auth";

export interface Env {
  CALLS: KVNamespace;

  // secrets — set with `wrangler secret put <NAME>`
  TELNYX_API_KEY: string;
  TELNYX_VERIFY_PROFILE_ID: string;
  SESSION_SECRET: string;
  ADMIN_SECRET: string;

  // vars — set in wrangler.toml
  TELNYX_FROM_NUMBER: string;
  /**
   * Persistent TeXML application used to place calls. We do NOT use the app
   * Telnyx auto-creates per assistant: that one defaults to anchorsite
   * "Latency" rather than a pinned region, and is not the connection the
   * from-number is assigned to.
   */
  TELNYX_CONNECTION_ID: string;
  ASSISTANT_MODEL: string;
  ASSISTANT_VOICE: string;
  ALLOWED_DESTINATIONS: string;
}

/** Sessions last a week. Re-verify by SMS after that. */
const SESSION_TTL_SECS = 7 * 24 * 60 * 60;
/** Call records outlive the call itself so `voxcall call` can be re-run against an id. */
const CALL_TTL_SECS = 24 * 60 * 60;
/** OTP sends allowed per phone number per hour. SMS to NL costs ~$0.09 a pop. */
const OTP_RATE_LIMIT = 5;

interface CallRecord {
  phone: string;
  assistantId: string;
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
 * Country allowlist, checked against the dial prefix. This is a cost control as
 * much as a policy one — it is the difference between a compromised token
 * costing you a few euros and costing you a few thousand.
 */
function destinationAllowed(phone: string, allowed: string): boolean {
  const prefixes: Record<string, string> = { NL: "+31", BE: "+32", DE: "+49", GB: "+44", US: "+1" };
  const list = allowed.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (list.includes("*")) return true;
  return list.some((c) => prefixes[c] && phone.startsWith(prefixes[c]));
}

async function rateLimit(env: Env, key: string, limit: number): Promise<boolean> {
  const k = `rl:${key}`;
  const current = parseInt((await env.CALLS.get(k)) ?? "0", 10);
  if (current >= limit) return false;
  await env.CALLS.put(k, String(current + 1), { expirationTtl: 3600 });
  return true;
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

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;
  return json({ token: await sign({ phone, exp }, env.SESSION_SECRET), phone, expiresAt: exp });
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

async function placeCall(req: Request, env: Env, origin: string): Promise<Response> {
  const s = await session(req, env.SESSION_SECRET);
  if (!s) return fail(401, "not authenticated — run `voxcall setup`");

  const { prompt, language } = (await req.json().catch(() => ({}))) as {
    prompt?: string;
    language?: string;
  };
  if (typeof prompt !== "string" || !prompt.trim()) return fail(400, "prompt is required");
  if (prompt.length > 4000) return fail(400, "prompt too long (max 4000 chars)");

  // "multi" lets Deepgram Flux follow Dutch/English code-switching mid-sentence,
  // which is how people actually speak in a Dutch business context.
  const lang = language === "en" || language === "nl" || language === "multi" ? language : "nl";
  if (!(await rateLimit(env, `call:${s.phone}`, 20)))
    return fail(429, "call limit reached for this number, try again in an hour");

  const callId = crypto.randomUUID();
  const wToken = await webhookToken(callId, env.SESSION_SECRET);

  // EU AI Act Article 50 requires the caller be told they are talking to an AI.
  // This is hard-coded as the assistant's greeting rather than left to the
  // system prompt, because a prompt instruction is something the model can skip.
  const greeting =
    lang === "en"
      ? "Hi, you're speaking with an AI assistant. "
      : "Hoi, je spreekt met een AI-assistent. ";

  const assistant = await telnyx.createAssistant(env.TELNYX_API_KEY, `voxcall-${callId}`, {
    instructions: prompt,
    model: env.ASSISTANT_MODEL,
    voice: env.ASSISTANT_VOICE,
    language: lang,
    greeting,
  });

  // Telnyx auto-provisions a TeXML app per assistant. We do not place calls
  // through it — it defaults to anchorsite "Latency" and is not the connection
  // the from-number is assigned to — but we do have to clean it up, since
  // deleting the assistant leaves it behind.
  const record: CallRecord = {
    phone: s.phone,
    assistantId: assistant.id,
    texmlAppId: assistant.telephony_settings?.default_texml_app_id,
    status: "initiated",
    createdAt: Date.now(),
  };
  await env.CALLS.put(`call:${callId}`, JSON.stringify(record), { expirationTtl: CALL_TTL_SECS });

  try {
    await telnyx.initiateAiCall(env.TELNYX_API_KEY, env.TELNYX_CONNECTION_ID, {
      from: env.TELNYX_FROM_NUMBER,
      // The session's phone, never a value from the request body. This is the
      // property that keeps the PoC from being a dialer.
      to: s.phone,
      assistantId: assistant.id,
      statusCallback: `${origin}/webhooks/${callId}/status?t=${wToken}`,
      conversationCallback: `${origin}/webhooks/${callId}/conversation?t=${wToken}`,
    });
  } catch (err) {
    await cleanupAssistant(env, record);
    await env.CALLS.delete(`call:${callId}`);
    return fail(502, `failed to place call: ${(err as Error).message}`);
  }

  return json({ callId, to: s.phone, status: "initiated" });
}

async function getCall(callId: string, req: Request, env: Env): Promise<Response> {
  const s = await session(req, env.SESSION_SECRET);
  if (!s) return fail(401, "not authenticated");

  const raw = await env.CALLS.get(`call:${callId}`);
  if (!raw) return fail(404, "unknown call id");
  const record = JSON.parse(raw) as CallRecord;
  if (record.phone !== s.phone) return fail(403, "not your call");

  const done = record.status === "completed" || record.status === "failed";
  if (!done) return json({ callId, status: record.status, done: false });

  // The conversation id normally arrives via the conversation webhook. If that
  // callback was lost, fall back to resolving it from the assistant id.
  let conversationId = record.conversationId;
  if (!conversationId) {
    conversationId =
      (await telnyx.findConversationByAssistant(env.TELNYX_API_KEY, record.assistantId)) ??
      undefined;
  }
  if (!conversationId) {
    return json({ callId, status: record.status, done: true, transcript: [] });
  }

  const transcript = await telnyx.getTranscript(env.TELNYX_API_KEY, conversationId);

  return json({
    callId,
    status: record.status,
    done: true,
    durationSecs: record.endedAt ? Math.round((record.endedAt - record.createdAt) / 1000) : null,
    transcript: transcript
      .filter((m) => m.text && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: m.role, text: m.text, at: m.sent_at ?? m.created_at })),
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
    "TELNYX_CONNECTION_ID",
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

      const call = path.match(/^\/calls\/([\w-]+)$/);
      if (method === "GET" && call) return await getCall(call[1], req, env);

      const hook = path.match(/^\/webhooks\/([\w-]+)\/(status|conversation)$/);
      if (method === "POST" && hook)
        return await handleWebhook(hook[1], hook[2] as "status" | "conversation", req, env);

      return fail(404, "not found");
    } catch (err) {
      if (err instanceof telnyx.TelnyxError) {
        console.error("telnyx error", err.status, err.path, err.body);
        return fail(502, `telnyx: ${err.message}`);
      }
      console.error("unhandled", err);
      return fail(500, (err as Error).message ?? "internal error");
    }
  },
};
