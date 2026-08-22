/**
 * Thin fetch wrapper over the parts of the OpenAI Realtime API we use to run a
 * phone call over SIP.
 *
 * The shape mirrors telnyx.ts on purpose: no SDK, just `fetch`, only the
 * endpoints we touch. Telnyx still owns the telephony (it dials the user and
 * bridges the leg to OpenAI over SIP); OpenAI owns the conversation and the
 * voice. This module is the OpenAI half:
 *
 *   - verify the `realtime.call.incoming` webhook Telnyx's bridge triggers,
 *   - accept that call with the session config (the brief, the voice, no tools),
 *   - reject it when we cannot (no correlation, out of credit),
 *   - and the URL of the control WebSocket the per-call Durable Object attaches
 *     to for the live transcript.
 */

const BASE = "https://api.openai.com/v1";

/** The SIP address a trunk bridges a leg to. EU endpoint to match the Amsterdam
 *  anchorsite — media stays in-region. `sip-eu` for EU, `sip` for the default. */
export const sipUri = (projectId: string, host = "sip-eu.api.openai.com") =>
  `sip:${projectId}@${host};transport=tls`;

/** The control WebSocket for an accepted call. Attaching to it streams the same
 *  session events a client would see — including the transcript deltas. */
export const callSocketUrl = (openaiCallId: string) =>
  `${BASE}/realtime?call_id=${encodeURIComponent(openaiCallId)}`;

/* ------------------------------------------------------------- webhook auth */

export interface IncomingCall {
  callId: string;
  /** SIP headers from the INVITE, lower-cased by name. Our correlation id
   *  rides in one of these (see X_CALL_HEADER). */
  sipHeaders: Record<string, string>;
}

/** The custom SIP header the Telnyx bridge stamps with our own call id, so the
 *  webhook can find the brief this call belongs to. Lower-cased: OpenAI reports
 *  header names as sent, and SIP is case-insensitive, so we match on lower. */
export const X_CALL_HEADER = "x-screenless-call";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Verifies a webhook against the Standard Webhooks spec, which OpenAI follows.
 *
 * Signed content is `${id}.${timestamp}.${rawBody}`; the secret is the base64
 * after the `whsec_` prefix; the signature header is a space-separated list of
 * `v1,<base64>` entries (a secret can be rotated, so more than one may be
 * valid at once). The raw body must be the exact bytes received — parsing and
 * re-serialising changes them and the HMAC no longer matches.
 */
export async function verifyWebhook(
  secret: string,
  rawBody: string,
  headers: Headers,
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader || !secret) return false;

  // Reject stale deliveries: a captured webhook must not be replayable forever.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const keyB64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(keyB64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${ts}.${rawBody}`),
  );
  const expected = bytesToB64(mac);

  // Constant-time-ish compare against each offered signature.
  return sigHeader
    .split(" ")
    .map((part) => part.split(",")[1] ?? "")
    .some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pulls our call id out of the SIP headers the webhook reports. */
export function correlationId(sipHeaders: Record<string, string>): string | null {
  return sipHeaders[X_CALL_HEADER] ?? null;
}

/** Normalises the webhook payload's SIP headers into a lower-cased name→value
 *  map. OpenAI reports them as `[{name, value}]`. */
export function parseIncoming(payload: unknown): IncomingCall | null {
  const data = (payload as { data?: { call_id?: string; sip_headers?: Array<{ name?: string; value?: string }> } })?.data;
  if (!data?.call_id) return null;
  const sipHeaders: Record<string, string> = {};
  for (const h of data.sip_headers ?? []) {
    if (h?.name) sipHeaders[h.name.toLowerCase()] = h.value ?? "";
  }
  return { callId: data.call_id, sipHeaders };
}

/* ---------------------------------------------------------------- the call */

export interface AcceptOptions {
  model: string;
  instructions: string;
  voice: string;
}

/**
 * Accepts the incoming SIP call and configures the session that will run it.
 *
 * No `tools`: the architectural rule is that the voice takes no action. It
 * collects decisions and hangs up; the caller's own machine applies them. A
 * session with no tools cannot break that even if the model tries.
 *
 * Returns 200 once OpenAI starts ringing the SIP leg with this config; after
 * that the Durable Object attaches to the control socket for the transcript.
 */
export async function acceptCall(
  apiKey: string,
  callId: string,
  o: AcceptOptions,
): Promise<void> {
  const res = await fetch(`${BASE}/realtime/calls/${callId}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "realtime",
      model: o.model,
      instructions: o.instructions,
      audio: { output: { voice: o.voice } },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI accept ${res.status}: ${body}`);
  }
}

/** Declines a call we cannot place — no correlation, or the org is out of
 *  credit. 486 Busy Here is the honest SIP response. */
export async function rejectCall(apiKey: string, callId: string): Promise<void> {
  await fetch(`${BASE}/realtime/calls/${callId}/reject`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status_code: 486 }),
  }).catch(() => {});
}
