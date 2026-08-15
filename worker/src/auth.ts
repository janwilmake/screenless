/**
 * Stateless session tokens: `base64url(payload).base64url(hmac)`.
 *
 * The payload carries the verified phone number. Everything the API does on a
 * user's behalf is scoped to that number, so a stolen token can still only ever
 * dial the phone it was minted for.
 */

const enc = new TextEncoder();

export interface SessionPayload {
  /** Verified phone number in E.164. */
  phone: string;
  /** Expiry, seconds since epoch. */
  exp: number;
  /**
   * Token generation for this number.
   *
   * A stateless token cannot be withdrawn, and `screenless logout` promised
   * exactly that. Sessions now last a year, so "wait for it to expire" is not
   * an answer to a leaked token. Logging out bumps the stored generation and
   * every token minted before it stops verifying.
   */
  v?: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function sign(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verify(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(secret),
    b64urlDecode(sig),
    enc.encode(body),
  );
  if (!ok) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    if (typeof payload.phone !== "string") return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

/** The generation counter for a number. Absent means zero. */
export async function tokenVersion(kv: KVNamespace, phone: string): Promise<number> {
  const raw = await kv.get(`tv:${phone}`);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Invalidates every token minted for this number so far. */
export async function revokeSessions(kv: KVNamespace, phone: string): Promise<number> {
  const next = (await tokenVersion(kv, phone)) + 1;
  await kv.put(`tv:${phone}`, String(next));
  return next;
}

/**
 * Extracts and validates the session from an Authorization: Bearer header.
 *
 * The KV read is the price of revocable tokens. It is one read against a key
 * that is almost never written, so it is cached at the edge and costs
 * essentially nothing — and without it `logout` is a lie.
 */
export async function session(
  req: Request,
  secret: string,
  kv?: KVNamespace,
): Promise<SessionPayload | null> {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const payload = await verify(header.slice(7), secret);
  if (!payload || !kv) return payload;

  return (payload.v ?? 0) >= (await tokenVersion(kv, payload.phone)) ? payload : null;
}

/**
 * Per-call webhook token. Telnyx signs its webhooks with ed25519, which is the
 * production answer; this is a lighter shared-secret check that at least stops
 * anyone who guesses a call id from writing to our KV.
 */
export async function webhookToken(callId: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    enc.encode(`webhook:${callId}`),
  );
  return b64urlEncode(new Uint8Array(sig)).slice(0, 32);
}

/** Constant-time-ish comparison. Short strings, but no reason to leak timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
