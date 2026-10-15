/**
 * Who is really calling: the caller id's attestation, and the spoken PIN that
 * stands in for it when the call does not carry one.
 *
 * The owner's own calls can do anything their Claude Code session may — send,
 * push, deploy. A caller id alone is easy to spoof, so that only holds when
 * the carrier vouched for the number (STIR/SHAKEN attestation A, signature
 * validated) or the caller said the PIN they set. Any other call is
 * restricted: it can talk and read, and the rest waits for after the call.
 *
 * The PIN is checked here, in the Worker, from a TeXML <Gather> that runs
 * before the voice is connected: the voice model never hears it, and it is
 * never in a transcript. Only a salted PBKDF2 hash is stored.
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

const SPOKEN: Record<string, string> = {
  zero: "0", oh: "0", o: "0", nul: "0", one: "1", een: "1", two: "2", to: "2", too: "2", twee: "2",
  three: "3", drie: "3", four: "4", for: "4", vier: "4", five: "5", vijf: "5", six: "6", zes: "6",
  seven: "7", zeven: "7", eight: "8", acht: "8", nine: "9", negen: "9",
};

/**
 * The digits of what the caller keyed or said. Keys win; speech arrives as
 * "1 2 3 4", "1234" or "one two three four" depending on the engine, in
 * English or Dutch.
 */
export function pinFromGather(params: Record<string, string>): string {
  const keyed = String(params.Digits ?? "").replace(/\D/g, "");
  if (keyed) return keyed;
  return String(params.SpeechResult ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => (/^\d+$/.test(w) ? w : (SPOKEN[w] ?? "")))
    .join("");
}
