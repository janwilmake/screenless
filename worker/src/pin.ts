/**
 * Who is really calling: the caller id's attestation, and the PIN that stands
 * in for it when the call does not carry one.
 *
 * The owner's own calls can do anything their Claude Code session may — send,
 * push, deploy. A caller id alone is easy to spoof, so that only holds when
 * the carrier vouched for the number (STIR/SHAKEN attestation A, signature
 * validated) or the caller keyed the PIN they set. Any other call is
 * restricted: it can talk and read, and the rest waits for after the call.
 *
 * The PIN is keyed on the phone during the call and checked in the Worker:
 * the call's Durable Object reads the keys off the media stream (keypad.ts),
 * so the voice model never has the digits and they are never in a transcript.
 * Only a salted PBKDF2 hash is stored.
 *
 * No imports, so the tests can load it in plain Node.
 */

export type CallMode = "full" | "restricted";

/**
 * What Telnyx passes on an inbound TeXML request when the TeXML application
 * has `inbound.shaken_stir_enabled`: `ShakenStirAttestation` ("A", "B" or
 * "C") and `ShakenStirValidated` ("true"/"false", form-encoded). Both are
 * absent when the call carried no Identity header — any call from outside
 * North America, so far.
 */
export interface Attestation {
  /** "A", "B", "C", or "" when the call carried none. */
  level: string;
  validated: boolean;
}

export function attestationOf(params: Record<string, string>): Attestation {
  const level = String(params.ShakenStirAttestation ?? params.shaken_stir_attestation ?? "")
    .trim()
    .toUpperCase();
  const validated = /^(true|1)$/i.test(String(params.ShakenStirValidated ?? params.shaken_stir_validated ?? ""));
  return { level: /^[ABC]$/.test(level) ? level : "", validated };
}

/** Full rights from the number alone: only A attestation with a valid signature. */
export const attested = (a: Attestation): boolean => a.level === "A" && a.validated;

/** How the last call's attestation reads in `screenless settings`. */
export const describeAttestation = (a: Attestation): string =>
  a.level ? `${a.level}${a.validated ? "" : " (signature not validated)"}` : "none";

/* -------------------------------------------------------------------- PIN */

export const PIN_RULE = /^\d{4,8}$/;
/** Tries per call before the call goes on restricted. */
export const PIN_TRIES = 3;
/** Wrong PINs per member per hour before the PIN stops being asked for, so
 *  ringing again and again cannot walk through four digits. */
export const PIN_FAILS_PER_HOUR = 10;

// 100 000 is the most PBKDF2 iterations Workers' WebCrypto runs.
const ITERATIONS = 100_000;

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)));

async function derive(pin: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
  return hex(bits);
}

/** A fresh salt and the hash to store for `pin`. */
export async function hashPin(pin: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await derive(pin, salt), salt: hex(salt) };
}

/** Whether `pin` matches the stored hash, compared in constant time. */
export async function verifyPin(pin: string, stored: { hash: string; salt: string }): Promise<boolean> {
  if (!PIN_RULE.test(pin) || !stored.hash || !stored.salt) return false;
  const got = await derive(pin, unhex(stored.salt));
  if (got.length !== stored.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}
