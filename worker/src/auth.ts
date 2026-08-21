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
   * Issued at, seconds since epoch.
   *
   * Revocation compares this against a stored "revoked before" timestamp, and
   * that direction matters. The first attempt stored a generation counter and
   * read it when minting — which broke, because KV reads are cached per edge
   * location for up to a minute. A mint could read a stale counter, stamp the
   * token with the old generation, and the very next request could hit a
   * location that had converged: a brand-new token, born invalid.
   *
   * Minting reads nothing now. A token issued after a logout always carries a
   * later timestamp than the logout, whatever any cache believes. The residual
   * staleness moves to the checking side, where it is merely a revoked token
   * surviving up to a minute — bounded, and far better than locking out a
   * valid one.
   */
  iat?: number;
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

/**
 * Extracts and validates the session token from an Authorization: Bearer
 * header. Pure signature-and-expiry: the revocation check lives with the
 * caller, because "is this token revoked" is a row on the user
 * (`tokens_revoked_at`) and this module deliberately knows nothing about
 * storage.
 */
export async function session(
  req: Request,
  secret: string,
): Promise<SessionPayload | null> {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return verify(header.slice(7), secret);
}

/* ------------------------------------------------------------ web sessions */

/**
 * Cookie session for the team page, signed the same way as the CLI token but
 * carrying a user id rather than a phone: the page's users include invitees
 * who have no verified phone yet, which is exactly what the page exists to fix.
 */
export interface WebPayload {
  uid: string;
  exp: number;
}

export async function signWeb(payload: WebPayload, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify({ ...payload, web: 1 })));
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyWeb(token: string, secret: string): Promise<WebPayload | null> {
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
    // `web: 1` keeps a CLI token from doubling as a cookie and vice versa.
    if (payload.web !== 1) return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    if (typeof payload.uid !== "string" || !payload.uid) return null;
    return { uid: payload.uid, exp: payload.exp };
  } catch {
    return null;
  }
}

/** The signed-in team-page user, from the session cookie. */
export async function webSession(req: Request, secret: string): Promise<WebPayload | null> {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)sl_session=([^;]+)/);
  if (!match) return null;
  return verifyWeb(match[1], secret);
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
