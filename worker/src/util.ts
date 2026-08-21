/**
 * Request plumbing shared by the API router and the team page: response
 * shapes, phone validation, the destination gate and the KV rate limiter.
 * Split out of index.ts when the team page started needing them — the page
 * verifies phones through the same guards the CLI does, not a copy of them.
 */

import type { Env } from "./index";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const fail = (status: number, message: string) => json({ error: message }, status);

/** E.164: leading +, country code, 7–14 more digits. */
export const isE164 = (s: unknown): s is string =>
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
export function normalizeCallerId(raw: string): string {
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
export const BLOCKED_PREFIXES = [
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
export function destinationAllowed(phone: string, allowed: string): boolean {
  if (BLOCKED_PREFIXES.some((p) => phone.startsWith(p))) return false;

  const list = allowed.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (!list.length || list.includes("*")) return true;

  // Must stay a superset of the outbound voice profile's whitelist. Telnyx
  // rejects a call to a country the profile does not list with D13, after the
  // call is already placed — so anything missing here fails late and opaquely
  // instead of failing here with a sentence the caller can act on.
  const prefixes: Record<string, string> = {
    NL: "+31", BE: "+32", DE: "+49", GB: "+44", US: "+1", CA: "+1",
    FR: "+33", ES: "+34", IT: "+39", PT: "+351", IE: "+353", DK: "+45",
    SE: "+46", NO: "+47", PL: "+48", CH: "+41", AT: "+43", AU: "+61",
    NZ: "+64", SG: "+65", JP: "+81", IN: "+91", BR: "+55", ZA: "+27",
    FI: "+358", CZ: "+420", LU: "+352", MX: "+52",
  };
  return list.some((c) => prefixes[c] && phone.startsWith(prefixes[c]));
}

export async function rateLimit(env: Env, key: string, limit: number, ttl = 3600): Promise<boolean> {
  const k = `rl:${key}`;
  const current = parseInt((await env.CALLS.get(k)) ?? "0", 10);
  if (current >= limit) return false;
  await env.CALLS.put(k, String(current + 1), { expirationTtl: ttl });
  return true;
}
