/**
 * Outbound calls over SIP, straight from OpenAI to Telnyx.
 *
 * The relay (live.ts) carries a call's audio through a Durable Object, and
 * measured on 21 Nov that path cost ~0.55 s of a ~1.9 s reply. Over SIP,
 * GPT-Live dials the user itself through a Telnyx credentials connection, the
 * audio never touches us, and the Worker keeps only the sideband: transcript,
 * handoffs, goodbye. OpenAI offers outbound SIP to every organisation; inbound
 * SIP (ring-ins) is gated per project and still takes the relay.
 *
 * The trunk's credentials are never typed by anyone: they are derived from
 * SESSION_SECRET here, used to create the Telnyx connection through its API
 * (`/admin/sip-trunk`), and sent to OpenAI on each call, which is how OpenAI
 * authenticates to a trunk (SIP digest, per request).
 */

import type { Env } from "./index";
import * as telnyx from "./telnyx";

const CONNECTION_NAME = "screenless-openai-sip";
/** Telnyx's SIP edge over TLS, which SRTP needs. Its EU host, to stay near
 *  the Amsterdam anchorsite. */
const PROVIDER_URL = "sips:sip.telnyx.eu:5061";

async function hmacHex(secret: string, label: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The trunk's SIP username and password. Telnyx: user 4–32 alphanumeric
 *  with a letter in the first five; password 8–128. */
export async function trunkCredentials(env: Env): Promise<{ username: string; password: string }> {
  const h = await hmacHex(env.SESSION_SECRET, "telnyx-openai-sip-trunk");
  return { username: `screenless${h.slice(0, 10)}`, password: h.slice(10, 58) };
}

/** What the admin needs to see before creating the trunk: the outbound
 *  voice profiles, any existing trunk, and where the test number routes. */
export async function inspect(env: Env): Promise<unknown> {
  const profiles = await telnyx.api<{ data: Array<{ id: string; name: string }> }>(env.TELNYX_API_KEY, "GET", "/outbound_voice_profiles");
  const conns = await telnyx.api<{ data: Array<Record<string, unknown>> }>(env.TELNYX_API_KEY, "GET", "/credential_connections?page[size]=50");
  const numbers: Record<string, unknown> = {};
  for (const n of [env.TELNYX_FROM_NUMBER, env.TEST_CALLER_NUMBER].filter(Boolean)) {
    const r = await telnyx.api<{ data: Array<Record<string, unknown>> }>(env.TELNYX_API_KEY, "GET", `/phone_numbers?filter[phone_number]=${encodeURIComponent(n)}`);
    const d = r.data[0];
    numbers[n] = d ? { connection_id: d.connection_id, connection_name: d.connection_name, status: d.status } : null;
  }
  const app = await telnyx
    .api<{ data: { outbound?: { outbound_voice_profile_id?: string } } }>(env.TELNYX_API_KEY, "GET", `/texml_applications/${env.TELNYX_TEXML_APP_ID}`)
    .catch(() => null);
  return {
    texmlAppProfile: app?.data.outbound?.outbound_voice_profile_id ?? null,
    profiles: profiles.data.map((p) => ({ id: p.id, name: p.name })),
    trunk: conns.data.filter((c) => c.connection_name === CONNECTION_NAME).map(({ password: _p, ...c }) => c),
    numbers,
  };
}

/** Creates the trunk, or updates it to these settings. */
export async function ensureTrunk(env: Env, profileId: string): Promise<unknown> {
  const { username, password } = await trunkCredentials(env);
  const body = {
    connection_name: CONNECTION_NAME,
    active: true,
    user_name: username,
    password,
    anchorsite_override: "Amsterdam, Netherlands",
    encrypted_media: "SRTP",
    outbound: { outbound_voice_profile_id: profileId, localization: "NL" },
  };
  const conns = await telnyx.api<{ data: Array<{ id: string; connection_name: string }> }>(env.TELNYX_API_KEY, "GET", "/credential_connections?page[size]=50");
  const existing = conns.data.find((c) => c.connection_name === CONNECTION_NAME);
  const res = existing
    ? await telnyx.api<{ data: Record<string, unknown> }>(env.TELNYX_API_KEY, "PATCH", `/credential_connections/${existing.id}`, body)
    : await telnyx.api<{ data: Record<string, unknown> }>(env.TELNYX_API_KEY, "POST", "/credential_connections", body);
  const { password: _p, ...shown } = res.data;
  return shown;
}

/**
 * Asks GPT-Live to dial `phone` through the trunk. Returns its session id,
 * which the sideband attaches to; the call is not answered yet.
 */
export async function dial(
  env: Env,
  o: { phone: string; instructions: string; voice: string; model: string },
): Promise<string> {
  const { username, password } = await trunkCredentials(env);
  const res = await fetch("https://api.openai.com/v1/live/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_LIVE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      session: {
        model: o.model,
        instructions: o.instructions,
        audio: { output: { voice: o.voice } },
        delegation: { type: "client" },
      },
      transport: {
        type: "sip",
        destination: o.phone,
        trunk: {
          provider_url: PROVIDER_URL,
          auth: { type: "digest", username, password },
          caller_number: env.TELNYX_FROM_NUMBER,
        },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI SIP dial ${res.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { session: { id: string } }).session.id;
}

/** Ends an outbound SIP call from our side. */
export async function hangup(env: Env, sessionId: string): Promise<void> {
  await fetch(`https://api.openai.com/v1/live/sessions/${sessionId}/hangup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_LIVE_API_KEY}` },
  }).catch(() => undefined);
}

export const sidebandUrl = (sessionId: string) => `https://api.openai.com/v1/live/sessions/${sessionId}/attach`;
