# voxcall

Call yourself with an AI voice agent from the command line. Blocks until the call ends, then prints the transcript.

```
$ voxcall call "vraag me hoe mijn week was en vat het samen"
→ calling +31612345678 (a3f1...)
  pick up — the agent opens by disclosing it is an AI
  ringing...
  answered...
  completed...

✓ call completed · 47s

agent  Hoi, je spreekt met een AI-assistent. Hoe was je week?
you    Druk, ik heb de hele week aan een voice agent gewerkt.
agent  Klinkt intensief. Wat was het lastigste onderdeel?
...
```

Dutch-first: Deepgram Flux for speech recognition with model-based turn detection, and `--lang multi` follows Dutch/English code-switching mid-sentence.

## How it fits together

```
  CLI  ──────────────►  Cloudflare Worker  ──────────────►  Telnyx
 (your laptop)              (holds the API key)          (Verify + AI Assistant)
       ▲                          ▲
       │  poll GET /calls/:id     │  status + conversation webhooks
       └──────────────────────────┘
```

Three decisions worth knowing about:

**The API key lives in the Worker, never the CLI.** The CLI holds only a session token bound to your verified phone number.

**Your phone number *is* your identity.** `voxcall setup` sends an OTP via the Telnyx Verify API; entering the code mints the session. No OAuth provider, no password.

**You can only call the number you verified.** The Worker takes `To` from the session token and ignores any number in the request body. That is deliberate: it makes the PoC structurally incapable of becoming a dialer, which matters given Dutch telemarketing law (see [Legal](#legal-before-you-call-anyone-else)).

The Worker is also the webhook receiver, so the CLI never needs a tunnel — it just polls.

---

## Setup

You need a [Telnyx account](https://telnyx.com/sign-up) and a Cloudflare account. Budget about 20 minutes.

**Only Telnyx is required — there is no separate Deepgram account.** Telnyx hosts the Deepgram models, selected via `transcription.model` in the assistant config, and bills them inside the $0.05/min. You would only need your own Deepgram or ElevenLabs key to bypass Telnyx's hosting (ElevenLabs voices require one, passed as `api_key_ref`).

### 1. Telnyx: get a number and a key

1. Buy a phone number. For a business, a Dutch **national** number is the easiest legitimate option — it needs a Dutch address but no area-code match and no proof-of-address document. **Local** (+31 geographic) numbers additionally require an address in the matching area code plus proof dated within 3 months. **Mobile** numbers have the lightest KYC but are flagged A2P-only, which is a poor fit for a conversational agent.
2. Create an API key under **API Keys**.
3. Set your **AnchorSite to Amsterdam** on the outbound voice profile. This is the whole reason for choosing Telnyx — their EU GPUs are co-located with the telephony PoP, so inference sits next to the SIP edge instead of crossing the Atlantic.

### 2. Cloudflare: deploy the Worker

```bash
cd worker
npm install

# KV stores call records and OTP rate-limit counters
npx wrangler kv namespace create CALLS
# paste the returned id into wrangler.toml
```

Edit `wrangler.toml`: set `TELNYX_FROM_NUMBER` to the number you bought, and the KV `id`.

```bash
npx wrangler secret put TELNYX_API_KEY      # from step 1
npx wrangler secret put SESSION_SECRET      # openssl rand -base64 32
npx wrangler secret put ADMIN_SECRET        # openssl rand -base64 32
npx wrangler deploy
```

### 3. Create the Verify profile

Telnyx requires a `verify_profile_id` on every OTP. The Worker has a one-shot admin endpoint for this:

```bash
curl -X POST https://voxcall.<you>.workers.dev/admin/verify-profile \
  -H "X-Admin-Secret: <your ADMIN_SECRET>"
```

It returns an id scoped to the countries in `ALLOWED_DESTINATIONS`. Store it and redeploy:

```bash
npx wrangler secret put TELNYX_VERIFY_PROFILE_ID
npx wrangler deploy
```

### 4. Install the CLI

```bash
cd ../cli
npm install && npm run build && npm link

voxcall setup --api https://voxcall.<you>.workers.dev
```

You'll get an SMS with a code (`--voice` gets you a phone call instead). Enter it, and you're done — the session lasts a week and lands in `~/.voxcall/config.json` at mode 0600.

---

## Usage

```bash
voxcall call "<prompt>"           # the prompt becomes the agent's instructions
voxcall call "..." --lang multi   # Dutch/English code-switching
voxcall call "..." --lang en      # English
voxcall call "..." --json         # raw result, for piping
voxcall whoami
voxcall logout
```

The `call` command blocks until the call reaches a terminal state, polling every 2s, and gives up after 15 minutes.

---

## Before this is useful, read this

### Voices

`ASSISTANT_VOICE` defaults to **"Sanne - Clear Companion"** (`Telnyx.Ultra.0eb213fe-…`), a Dutch female voice verified present on a live Telnyx account. To see the alternatives:

```bash
cd worker
npm run voices            # 12 Telnyx-hosted Dutch voices
npm run voices nl all     # all 43, including AWS/Azure/Inworld/MiniMax
npm run voices nl-BE all  # Flemish — 3 voices, all third-party
```

Prefer `hosted: true` voices (Telnyx.Ultra.*, Resemble.Pro.*): they run on Telnyx's own GPUs, so they need no third-party API key and avoid a network hop mid-call. The Flemish (nl-BE) options are AWS and Azure only — consistent with Flemish being the least-served variant across the whole industry.

Ten of the Dutch voices are Telnyx's own, with descriptions like *"Clear, articulate Dutch female for efficient professional assistance"* — pick by use case rather than by guessing.

### Costs

Roughly **$0.056–0.07/minute** all-in per call ($0.05 Telnyx voice AI + ~$0.004 LLM + telephony). Verification is **$0.03 per successful verify plus $0.091 per SMS to a Dutch number** — the SMS is charged even on failed attempts, which is why `/auth/start` is rate-limited to 5/hour per number. Dutch outbound termination rates are not public; pull the SIP price sheet from the Telnyx pricing page before modelling volume.

### Latency expectations

Independent benchmarks measuring what a caller actually experiences — end of your speech to first agent audio, including endpointing and telephony — put every major platform at **1.3–2.4 seconds**, not the sub-500ms figures in the marketing. Human conversation gaps average ~200ms; above 800ms callers start talking over the agent. Flux's model-based end-of-turn detection attacks the biggest tunable slice; `eot_threshold` and `eager_eot_threshold` in `worker/src/telnyx.ts` are the knobs.

### Legal, before you call anyone else

This tool only calls the number you verified, so none of the below applies to testing on yourself. It all applies the moment you point it at someone else.

- **AI disclosure is mandatory and already in force.** EU AI Act Article 50 applied 2 August 2026 with no grace period; penalties reach €15M or 3% of worldwide turnover. The agent's greeting is hard-coded in `worker/src/index.ts` rather than left to the system prompt, because a prompt instruction is something the model can silently skip. Don't remove it.
- **You cannot cold-call Dutch consumers.** Opt-in has been required since July 2021, and as of 1 July 2026 the existing/former-customer exception is gone too.
- **zzp'ers and eenmanszaken count as natural persons** — the most-missed trap, and it covers most Dutch self-employed people. Only *rechtspersonen* (BV, NV, stichting, vereniging) remain cold-callable.
- **The Bel-me-niet Register no longer exists.** It was abolished and its data deleted. Vendor tools still advertising "automatic register checks" are selling something that isn't there.
- **Anonymous caller ID is illegal** for telemarketing — your number must be visible and answerable.
- **Open question worth real legal advice:** Telecommunicatiewet art. 11.7(1) bans automated calling systems *"zonder menselijke tussenkomst"* without prior consent. It was written for recorded-message robocalls, but a fully autonomous AI agent arguably has no human intervention either — which could pull even B2B calls to rechtspersonen under the opt-in ban. No ACM decision resolves it. Get Dutch counsel before scaling autonomous outbound.

---

## Status: blocked on a Telnyx-side issue

Everything in this repo works. The AI Assistant does not produce audio on
telephony calls, and that failure is upstream of this code.

Verified working: outbound calls, TTS in-call (plain TeXML `<Say>` is audible),
speech-to-text during the failing calls, the assistant over text
(`POST /v2/ai/assistants/{id}/chat`), standalone TTS, direct model invocation,
and the assistant's own TeXML document.

Verified failing: any call with an assistant connected. Zero `assistant`
messages are recorded and the caller hears silence. Reproduced with both
`/texml/ai_calls` and `/texml/calls` + `<Connect><AIAssistant>`, across two
models, two voices, two transcription languages, two anchorsites, with and
without callbacks — and with an assistant created by Telnyx's own portal demo
rather than by this code.

`/texml/say` is left in the worker as the isolation test: if calls go silent,
point a TeXML application at it. If you hear it, telephony and TTS are fine and
the fault is in the assistant layer.

## Setup gotchas found the hard way

- **The default outbound voice profile only whitelists US and CA.** Any Dutch
  destination is refused with `D13` until you add `NL`. This is not mentioned
  during number purchase.
- **`StatusCallbackEvent` must be a space-separated string**, not a JSON array,
  unlike the TwiML convention of repeating the parameter.
- **Verify profiles need `whitelisted_destinations` on the `call` channel too**,
  not just `sms` — it is not inherited, and the docs example only shows `sms`.
- **Deleting an assistant does not delete its auto-provisioned TeXML app.**
  Clean both up or they accumulate one per call.
- **Dutch national (+3185) numbers require regulatory approval** that a KvK
  *handelsnaam* may not satisfy. A US number has no requirements and activates
  instantly, which is fine for a PoC that only calls your own verified phone.

## Known gaps

This is a PoC. What's deliberately missing:

- **Webhook signature verification.** Telnyx signs webhooks with ed25519; the Worker checks an HMAC token in the URL instead. Good enough to stop someone who guesses a call id, not a substitute for signature verification.
- **One assistant per call**, created and deleted each time. Clean 1:1 mapping to the conversation, but it adds a round-trip to call setup. A long-lived assistant with per-call dynamic variables would be faster.
- **No `--from` support.** Adding it means adding the ability to call arbitrary numbers, which is the one thing the design currently prevents.
- **Transcript only.** Telnyx conversation insights (summaries, structured extraction) need an `insight_group_id` on the assistant; not wired up.
- **Single-tenant.** One Telnyx account, one from-number, sessions keyed only by phone number.

## Layout

```
worker/src/index.ts    routes, auth, call lifecycle, webhooks
worker/src/telnyx.ts   Telnyx REST wrapper (verify, assistants, conversations)
worker/src/auth.ts     HMAC session tokens
cli/src/index.ts       commands
cli/src/config.ts      ~/.voxcall/config.json
```

## License

MIT
