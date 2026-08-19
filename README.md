# screenless

Understand what your agents built last night without opening a laptop.

You already run coding agents that turn tickets into pull requests overnight.
The code gets written; the bottleneck moved. Someone still has to make the calls
the model cannot — is this the right scope, does this belong in the release, is
this abstraction worth it. Those are taste and priority questions, not
correctness questions, so they do not disappear as models improve.

Today that costs an hour at a screen before you have had coffee. It does not
need a screen.

**Who this is for:** senior engineers who already have agents producing more
pull requests than they want to read on a laptop.

## Two surfaces, one idea

| | **the call** | **the paper** |
| --- | --- | --- |
| What | A 30-minute morning call that walks your open PRs and takes your decisions | A daily printable PDF in your inbox — visual, almost no text |
| Answers | *What do I need to decide today?* | *What is my product actually becoming?* |
| Shape | Interruptible conversation, CLI-triggered | One-way, glanceable, printable |
| Screen time | Zero — it is a phone call | Zero, if you print it |

They share a name because paper and a phone call are the only two media in this
workflow that are not a screen.

### the call

```
22:40  claude> /screenless start
       waiting for work — probe every 60s

03:00  --- woke after 4h20m ---  NIGHTLY ~/code/your-repo
       $ screenless call "<brief>" --at
       ✓ parked — calling +31612345678 at 08:00 · 14 PRs open, 6 need you

08:00
agent  Morning. Six decisions, about nine minutes. First one:
       HYR2-441 adds a `notes` field to candidates. The agent
       put it in a JSONB column. Separate table or leave it?
you    What else reads it?
agent  Nothing yet. It's write-only from the intake form.
you    Leave it. Revisit when something queries it.
agent  Got it — JSONB stays, revisit on first read. Next:
       HYR2-448 changes the default page size from 25 to 100 —
you    Wait, why is that in a ticket about export?
agent  It isn't scoped there. Split it out, or leave it?
you    Split it, and hold the export PR until that's gone.
...

✓ 6 decisions · 8m41s · nothing changed yet

08:09  --- woke after 5h9m ---  APPLY 5ef8e342
       $ screenless transcript --json
       ✓ 4 merged · 1 split · 1 comment · 1 left for your eyes
```

Note where the work happens. The voice on the phone has no tools and no
credentials — it collects decisions and hangs up. Your own loop applies them
afterwards, with the access you already gave it.

And one decision could not be made by voice: the call said so instead of
pressing you for an answer while you are walking the dog.

### the paper

A single daily PDF, mailed to land at wake-up, built to be printed and read
with coffee:

- **One page per ticket in flight**, mostly picture: what surface it touches,
  a screenshot of that surface as it looks today, and what will look different
  when it lands.
- **A product map**, not a changelog — what area got heavier this week, what has
  not been touched in a month, where the agents are concentrating.
- **Text kept to captions.** If a page needs a paragraph, it belongs in the call
  instead.

The goal is not status reporting. It is that reading it makes you understand your
own product better than you did yesterday — which is the thing that gets quietly
lost when agents write most of the code.

## How it installs

```bash
curl -fsSL https://screenless.sh/install | bash
```

One command: the CLI lands in `~/.screenless`, gets a launcher on your PATH, and
goes straight into `screenless setup` — phone verification by SMS, then a 7-day
free trial ($99/month after, card up front). Node 20+ required and never
installed for you.

Both surfaces are built by a **loop armed inside a Claude Code session on your
own machine**:

```
/screenless start      # in Claude Code, in a repo you ran `screenless init` in
```

It runs one tick, then blocks in pure shell — `screenless wait`, probing every
minute, no model, no tokens — until there is something to do: 03:00 (or the
first minute after the laptop wakes), or a finished call whose decisions nobody
has applied. The exit wakes the agent, which builds the paper and the brief, or
applies what you decided on the phone, with the permissions, MCPs and browser
the session already has. Leave the window open; `/screenless stop` ends it.

It is deliberately a session and not a scheduler. The first version was two
launchd jobs running `claude -p`; they could not read a repo under `~/Desktop`,
could not approve a tool call, and fired every night for four nights without
shipping a page. The orchestrator already runs as an armed session for the same
reason, and this is the same contract. That is the whole integration story:

- **Your MCP servers are the integrations.** Linear, GitHub, Slack, your ATS —
  whatever you have already connected, it can already read. There is no OAuth
  app to install, no third-party grant to review, no integration matrix to build
  or maintain.
- **Your browser is the screenshot tool.** The paper's visuals come from driving
  a real session against your real app, already logged in. A hosted service
  cannot do this without credentials you should not give it.
- **Your Claude subscription is the LLM.** Nothing is metered per token by us.
- **Nothing leaves your machine** except the phone call and the email.

This is the same reason `linear-orchestrator` runs locally: the agents need your
repo, your dev server, and your browser. screenless sits on the same substrate
and inherits the same access.

## Status — read this before anything else

This repository is a **working primitive plus a product thesis**. Be clear on
which is which.

**Built and working:** outbound calling, phone-number verification by OTP,
per-call AI assistant creation, an interruptible two-way conversation, call
records, and transcript retrieval. That is the hard telephony half.

**Not built:** everything that makes the transcript above real — pull-request
ingestion, cross-repo triage, agenda building, speech-shaped summarisation of a
diff, the "this one needs your eyes" router, and writeback to the PR.
`screenless brief` does not exist yet. What exists is `screenless call
"<prompt>"`, the primitive it will sit on.

**Built and working (the paper):** the chart library, the fact collector, the
PDF renderer, the print stylesheet, the loop in `loop/SKILL.md` with its
`screenless wait` gate, and scheduled delivery via `screenless mail`. `press/example/edition.json` renders to
a six-page PDF today. It has not yet run unattended against a real repo for a
week, which is the only test that counts.

**Blocked upstream:** Telnyx AI Assistants currently produce no audio on
telephony calls. See [Blocked on Telnyx](#blocked-on-telnyx). Until that clears,
the call cannot be demonstrated end to end. The paper is not affected by this and
is the cheaper thing to build first.

## How the call fits together

```
  CLI  ──────────────►  Cloudflare Worker  ──────────────►  Telnyx
 (your laptop)              (holds the API key)          (Verify + AI Assistant)
       ▲                          ▲
       │  poll GET /calls/:id     │  status + conversation webhooks
       └──────────────────────────┘
```

Three decisions worth knowing about:

**The API key lives in the Worker, never the CLI.** The CLI holds only a session
token bound to your verified phone number.

**Your phone number *is* your identity.** `screenless setup` sends an OTP via the
Telnyx Verify API; entering the code mints the session. No OAuth provider, no
password.

**You can only call the number you verified.** The Worker takes `To` from the
session token and ignores any number in the request body. That is deliberate: it
makes this structurally incapable of becoming a dialer, which matters given Dutch
telemarketing law (see [Legal](#legal-if-you-ever-point-this-at-someone-else)).

The Worker is also the webhook receiver, so the CLI never needs a tunnel — it
just polls.

## Why a call, and not a notification

The notification tier is commoditised. Claude Code ships first-party push;
several free tools do desktop and Telegram alerts; Pushary does two-way approval
from a lock screen. All of them are **session-scoped**: one agent, one block, one
ping, one answer.

This is **portfolio-scoped and scheduled**. It is not an interrupt — it is a
standing meeting you opted into, draining a prioritised queue across every PR
your agents opened last night. That needs cross-PR state, an agenda, and
writeback, none of which a per-tool-call hook grows into.

The nearest thing to this shape is a generated audio digest, and the reason that
format loses is that **you cannot interrupt it**. Half the value above is the
line where you cut in with "wait, why is that in a ticket about export?" A live
call has that property for free.

## Economics

Telnyx bills roughly **$0.056–0.07/minute** all-in ($0.05 voice AI + ~$0.004 LLM
+ telephony).

| Call length | Minutes/mo (22 workdays) | COGS/mo |
| ----------- | ------------------------ | ------- |
| 30 min/day  | 660                      | $37–46  |
| 15 min/day  | 330                      | $18–23  |
| 10 min/day  | 220                      | $12–15  |

At the target price of **$99/month**, a 30-minute daily call is a 54–63% gross
margin. That is below the usual SaaS 70–80%, and it inverts the normal incentive:
heavy users cost real money. Three consequences worth designing around:

- **Sell a minute ceiling, not "unlimited."** 30 min/day is the plan, not the
  target — the product should hang up as soon as the queue is drained.
- **The COGS is also the moat.** No first-party vendor will bundle $40/month of
  telephony into a subscription, which is exactly why the notification tier got
  commoditised and this one will not.
- **The paper carries almost no COGS**, since it runs on your machine against
  your own Claude subscription. It is the margin ballast for the bundle, and it
  can ship without waiting on Telnyx.

Verification is charged separately: **$0.03 per successful verify plus $0.091 per
SMS to a Dutch number** — billed even on failed attempts, which is why
`/auth/start` is rate-limited to 5/hour per number.

## Setup

You need a [Telnyx account](https://telnyx.com/sign-up) and a Cloudflare account.
Budget about 20 minutes. (This section covers the call only; the paper has
nothing to set up yet.)

**Only Telnyx is required — there is no separate Deepgram account.** Telnyx hosts
the Deepgram models, selected via `transcription.model` in the assistant config,
and bills them inside the $0.05/min. You would only need your own Deepgram or
ElevenLabs key to bypass Telnyx's hosting (ElevenLabs voices require one, passed
as `api_key_ref`).

### 1. Telnyx: get a number and a key

1. Buy a phone number. For a business, a Dutch **national** number is the easiest
   legitimate option — it needs a Dutch address but no area-code match and no
   proof-of-address document. **Local** (+31 geographic) numbers additionally
   require an address in the matching area code plus proof dated within 3 months.
   **Mobile** numbers have the lightest KYC but are flagged A2P-only, which is a
   poor fit for a conversational agent.
2. Create an API key under **API Keys**.
3. Set your **AnchorSite** on the outbound voice profile to the region nearest
   your users. This is the whole reason for choosing Telnyx — their GPUs are
   co-located with the telephony PoPs, so inference sits next to the SIP edge.

### 2. Cloudflare: deploy the Worker

```bash
cd worker
npm install

# KV stores call records and OTP rate-limit counters
npx wrangler kv namespace create CALLS
# paste the returned id into wrangler.toml
```

Edit `wrangler.toml`: set `TELNYX_FROM_NUMBER` to the number you bought, the KV
`id`, and — see the warning in that file — an `ASSISTANT_VOICE` matching your
default language.

```bash
npx wrangler secret put TELNYX_API_KEY      # from step 1
npx wrangler secret put SESSION_SECRET      # openssl rand -base64 32
npx wrangler secret put ADMIN_SECRET        # openssl rand -base64 32
npx wrangler deploy
```

### 3. Create the Verify profile

Telnyx requires a `verify_profile_id` on every OTP. The Worker has a one-shot
admin endpoint for this:

```bash
curl -X POST https://api.screenless.sh/admin/verify-profile \
  -H "X-Admin-Secret: <your ADMIN_SECRET>"
```

It returns an id scoped to the countries in `ALLOWED_DESTINATIONS`. Store it and
redeploy:

```bash
npx wrangler secret put TELNYX_VERIFY_PROFILE_ID
npx wrangler deploy
```

### 4. Stripe: the paywall

Billing stays inert while `STRIPE_SECRET_KEY` is unset, so skip this section
entirely if you are running your own Worker for yourself — every verified number
is then entitled.

```bash
stripe products create --name="screenless"
stripe prices create --product=<product id> --unit-amount=9900 \
  --currency=usd -d "recurring[interval]=month"

stripe webhook_endpoints create \
  --url="https://api.screenless.sh/stripe/webhook" \
  --enabled-events=checkout.session.completed \
  --enabled-events=customer.subscription.created \
  --enabled-events=customer.subscription.updated \
  --enabled-events=customer.subscription.deleted \
  --enabled-events=customer.subscription.trial_will_end
```

Put the price id in `wrangler.jsonc` as `STRIPE_PRICE_ID`, then:

```bash
npx wrangler secret put STRIPE_SECRET_KEY      # sk_test_… or sk_live_…
npx wrangler secret put STRIPE_WEBHOOK_SECRET  # whsec_… from the command above
npx wrangler deploy
```

The trial is 7 days with the card taken up front, and a number that has held a
subscription before does not get a second one. Going live is those three values
swapped for their live-mode equivalents — there is no code path that differs.

### 5. Inbound: let people ring back

So a declined morning call can be taken later, the number has to answer. Ask the
Worker for its signed voice URL:

```bash
curl https://api.screenless.sh/admin/inbound-url -H "X-Admin-Secret: <ADMIN_SECRET>"
```

In the Telnyx portal, set that as the Voice URL (POST) of a TeXML application
and assign `TELNYX_FROM_NUMBER` to it. Whoever rings in gets the brief already
parked for their number — the same conversation the 07:00 call would have been.

### 6. Install the CLI

```bash
curl -fsSL https://screenless.sh/install | bash
```

That fetches the CLI into `~/.screenless`, puts a launcher on your PATH, and
drops straight into `screenless setup`. It needs Node 20+ and will not install
it for you.

The call goes out at 08:00 in **your machine's timezone**, which is read from
the machine itself on every settings call — there is no timezone to configure,
and moving country corrects the schedule on its own.

Setup asks `Self-hosted Worker? y/N` first. Answering no — the default — points
at `https://api.screenless.sh`. Answering yes prompts for your own Worker URL,
and `--api <url>` skips the question entirely.

Working on the CLI itself:

```bash
cd ../cli
npm install && npm run build && npm link
screenless setup --api https://api.screenless.sh
```

Either way you'll get an SMS with a code (`--voice` gets you a phone call
instead). Enter it, start the trial, and you're done — the session lasts a week
and lands in `~/.screenless/config.json` at mode 0600.

Publishing anything — a CLI change, a page edit, a change to the loop skills —
is one command:

```bash
cd site && npm run deploy
```

`site/public/` is generated in full by `site/build.sh` and gitignored. Edit
`site/src/` for the pages and installer, `loop/` for the skills, `press/` for the toolkit,
`cli/src/` for the CLI; never edit `site/public/`, because the next build
deletes it.

## Usage

```bash
screenless call "<prompt>"           # the prompt becomes the agent's instructions
screenless call "..." --lang en      # English (default)
screenless call "..." --lang nl      # Dutch
screenless call "..." --lang multi   # Dutch/English code-switching
screenless call "..." --json         # raw result, for piping

screenless call "..." --at           # park it for your configured call time
screenless call "..." --at 06:30     # park it for a specific local time
screenless call "..." --hold         # park with no time — waits until you ring in

screenless transcript                # what was decided on the last call
screenless transcript --wait --json  # block until it ends, then emit JSON

screenless settings                       # call time, timezone, ring-back number
screenless settings --at 08:00            # when the morning call goes out (default 08:00)
screenless settings --pause               # stop the scheduled call

screenless billing            # trial status
screenless billing --manage   # Stripe's portal: change card, cancel

screenless whoami
screenless logout
```

### The nightly shape

The loop on your machine writes the brief and parks it; the Worker dials at your
time; the loop reads back what you decided and is the thing that acts on it.
`screenless wait` is the gate the armed session blocks on; the agent does the
rest in-session, but the primitives are plain commands:

```bash
screenless wait                    # blocks; prints NIGHTLY <repo> or APPLY <id>

# 03:00, when your agents are done — the agent builds the brief, then:
screenless call "<brief>" --at     # parked for your call time

# 08:09, after the call — the agent reads it and acts:
screenless transcript --json
screenless applied <callId>
```

The assistant on the phone has no tools and takes no action — it collects
decisions and hangs up. Everything that merges, comments or closes runs on your
machine, with the access you already gave it. Decline the call and ring the
number back whenever suits: same brief, same conversation.

`mail` hands the PDF to the Worker, which parks it in KV and sends it on a
five-minute cron sweep once it comes due. The Worker holds it rather than your
laptop because the machine that builds the paper at 03:00 is usually asleep by
06:30. It needs `RESEND_API_KEY` set as a Worker secret and a verified sender
domain — without them the sweep fails silently, since nobody is watching a cron.

`call` blocks until the call reaches a terminal state, polling every 2s, and
gives up after 15 minutes.

Until `screenless brief` exists, you can approximate it by piping your own PR
summary into the prompt:

```bash
gh pr list --json number,title,body --limit 20 \
  | screenless call "$(cat -)  — walk me through these and ask me to decide on each"
```

That is a demo, not the product: there is no triage, no writeback, and a long
prompt will blow past the 4000-character limit.

## Configuration

Defaults live in `worker/wrangler.toml`:

| Var | Default | Notes |
| --- | --- | --- |
| `ASSISTANT_MODEL` | `anthropic/claude-haiku-4-5` | Time-to-first-token is the biggest latency slice |
| `ASSISTANT_VOICE` | *(Dutch — change it)* | See the warning in the file |
| `TELNYX_ANCHORSITE` | `Amsterdam, Netherlands` | Pin media to a region near your users |
| `ALLOWED_DESTINATIONS` | `NL` | Doubles as a spend guard; widen for non-NL users |

`ALLOWED_DESTINATIONS` is the one to revisit first if you take this beyond
yourself — a product for senior engineers that only dials Dutch numbers is not a
product.

### Voices

```bash
cd worker
npm run voices en         # Telnyx-hosted English voices
npm run voices en all     # every provider
npm run voices nl all     # Dutch, all 43
```

Prefer `hosted: true` voices (`Telnyx.Ultra.*`, `Resemble.Pro.*`): they run on
Telnyx's own GPUs, so they need no third-party API key and avoid a network hop
mid-call.

### Latency expectations

Independent benchmarks measuring what a caller actually experiences — end of your
speech to first agent audio, including endpointing and telephony — put every
major platform at **1.3–2.4 seconds**, not the sub-500ms figures in the
marketing. Human conversation gaps average ~200ms; above 800ms callers start
talking over the agent.

For this product that matters less than it would for a snappy assistant. A
deliberative review call has natural pauses — you are thinking about whether the
field belongs in its own table. `eot_threshold` and `eager_eot_threshold` in
`worker/src/telnyx.ts` are the knobs if you want them.

## Blocked on Telnyx

Everything in this repo works. The AI Assistant does not produce audio on
telephony calls, and that failure is upstream of this code.

Verified working: outbound calls, TTS in-call (plain TeXML `<Say>` is audible),
speech-to-text during the failing calls, the assistant over text
(`POST /v2/ai/assistants/{id}/chat`), standalone TTS, direct model invocation,
and the assistant's own TeXML document.

Verified failing: any call with an assistant connected. Zero `assistant` messages
are recorded and the caller hears silence. Reproduced with both
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
- **Deleting an assistant does not delete its auto-provisioned TeXML app.** Clean
  both up or they accumulate one per call.
- **Dutch national (+3185) numbers require regulatory approval** that a KvK
  *handelsnaam* may not satisfy. A US number has no requirements and activates
  instantly, which is fine while you only call your own verified phone.

## Legal, if you ever point this at someone else

This tool only calls the number you verified, so none of the below applies to
using it on yourself — which is the entire intended product. It all applies the
moment you point it at anyone else.

- **AI disclosure is mandatory and already in force.** EU AI Act Article 50
  applied 2 August 2026 with no grace period; penalties reach €15M or 3% of
  worldwide turnover. The agent's greeting is hard-coded in `worker/src/index.ts`
  rather than left to the system prompt, because a prompt instruction is
  something the model can silently skip. Don't remove it.
- **You cannot cold-call Dutch consumers.** Opt-in has been required since July
  2021, and as of 1 July 2026 the existing/former-customer exception is gone too.
- **zzp'ers and eenmanszaken count as natural persons** — the most-missed trap,
  and it covers most Dutch self-employed people. Only *rechtspersonen* (BV, NV,
  stichting, vereniging) remain cold-callable.
- **The Bel-me-niet Register no longer exists.** It was abolished and its data
  deleted. Vendor tools still advertising "automatic register checks" are selling
  something that isn't there.
- **Anonymous caller ID is illegal** for telemarketing — your number must be
  visible and answerable.

## Known gaps

- **The product itself.** See [Status](#status--read-this-before-anything-else).
  PR ingestion, triage, agenda, writeback, `screenless brief`, and the entire
  paper surface are unbuilt.
- **Webhook signature verification.** Telnyx signs webhooks with ed25519; the
  Worker checks an HMAC token in the URL instead. Good enough to stop someone who
  guesses a call id, not a substitute for signature verification.
- **One assistant per call**, created and deleted each time. Clean 1:1 mapping to
  the conversation, but it adds a round-trip to call setup. A long-lived
  assistant with per-call dynamic variables would be faster — and is close to
  required for a scheduled daily call.
- **The 4000-character prompt limit** is well below a real PR agenda. Whatever
  builds the agenda will need to summarise before it dials, not stuff context
  into the prompt.

## Layout

```
cli/                    the shared `screenless` binary
  src/index.ts            setup, call, mail, whoami, logout
  src/config.ts           ~/.screenless/config.json
worker/                 shared backend — telephony + scheduled mail
  src/index.ts            routes, webhooks, call records, cron
  src/auth.ts             OTP, session tokens
  src/mail.ts             outbox, wake-up scheduling, delivery
  src/telnyx.ts           Telnyx API client
  wrangler.toml           all tunable defaults
press/                  the nightly paper — built, see press/README.md
  SKILL.md                the loop Claude Code runs
  bin/collect.mjs         deterministic facts from git + gh
  bin/render.mjs          edition.json -> HTML -> PDF
  lib/charts.mjs          dependency-free SVG charts for paper
rounds/                 the morning call — planned, see rounds/README.md
site/index.html         the landing page (screenless.sh)
```

## License

MIT — see [LICENSE](LICENSE).
