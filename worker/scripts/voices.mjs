#!/usr/bin/env node
/**
 * Lists the voices available on your Telnyx account for a given language.
 *
 *   node scripts/voices.mjs          # Dutch, Telnyx-hosted only
 *   node scripts/voices.mjs nl all   # Dutch, every provider
 *   node scripts/voices.mjs nl-BE all
 *
 * Reads TELNYX_API_KEY from the environment or from .dev.vars.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function apiKey() {
  if (process.env.TELNYX_API_KEY) return process.env.TELNYX_API_KEY;
  try {
    const vars = readFileSync(join(here, "..", ".dev.vars"), "utf8");
    const match = vars.match(/^TELNYX_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    /* fall through */
  }
  console.error("No TELNYX_API_KEY in the environment or .dev.vars");
  process.exit(1);
}

const lang = (process.argv[2] ?? "nl").toLowerCase();
const scope = process.argv[3] ?? "hosted";

const res = await fetch("https://api.telnyx.com/v2/text-to-speech/voices", {
  headers: { Authorization: `Bearer ${apiKey()}` },
});
if (!res.ok) {
  console.error(`Telnyx ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const { voices } = await res.json();
let matches = voices.filter((v) => String(v.language ?? "").toLowerCase().startsWith(lang));

// Telnyx-hosted voices run on Telnyx's own GPUs: no third-party API key, and
// lower latency because they are not a network hop away from the call.
if (scope !== "all") matches = matches.filter((v) => v.hosted);

if (!matches.length) {
  console.log(`No ${scope === "all" ? "" : "Telnyx-hosted "}voices for "${lang}".`);
  console.log(`Try: node scripts/voices.mjs ${lang} all`);
  process.exit(0);
}

console.log(`${matches.length} voice(s) for "${lang}"${scope === "all" ? "" : " (Telnyx-hosted)"}\n`);
for (const v of matches.sort((a, b) => a.id.localeCompare(b.id))) {
  const tag = v.hosted ? "hosted" : v.provider;
  console.log(`  ${v.name ?? "(unnamed)"}  ${v.gender ?? "?"}  [${tag}]`);
  if (v.label) console.log(`    ${v.label}`);
  console.log(`    ${v.id}\n`);
}
console.log("Set the chosen id as ASSISTANT_VOICE in wrangler.toml.");
