# Intent, resolved

Last updated: 2026-08-20 — covers sessions 1–8, through the 06:12 prompt in
session 8. If the session files carry prompts newer than that, this document
is behind them and they win.

Every instruction given across both sessions, collapsed to its final form —
where an instruction was later replaced, only the replacement is listed, with
the superseded version noted so the reversal is not lost. Then checked against
what the code actually does.

Status: **built** = in the product and exercised · **built, unrun** = in the
product, never executed against reality · **not built**.

## The product

| Intent | Status |
|---|---|
| Get the decisions coding agents are blocked on out of a screen and into a phone call | not built — `rounds` does not exist |
| A nightly printable paper about your own product | built, unrun end to end |
| The paper and the call built together from one reading *(was: two loops)* | built, unrun |
| The phone assistant takes **no** action; the transcript goes to the user's own loop, which acts | built |

## The call

| Intent | Status |
|---|---|
| Three items per call, never more; each a dossier — context first, confirmed, then the one question; the assistant answers from the brief and says when it cannot *(was: three to six decisions, two sentences each)* | **built and proven** — the 22:10 call on 19 Aug |
| Hang up on voicemail rather than brief it | **built and proven** — async AMD, hung up in 5 s |
| No transcript email; the loop mails what was decided and applied *(was: transcript mailed after every call)* | built and run once |
| CLI: `call "<prompt>"` blocks and returns the transcript | built |
| Auth by phone number + OTP, no passwords, no Google SSO *(was: Google SSO)* | built |
| Only ever dials the number that was verified | built |
| Calls come from the Dutch number, and it can be rung back *(was: a US number while the NL review was pending)* | **built and proven** — test call from +31 85 083 5195 answered 19 Aug |
| Telnyx, EU media anchoring, interruptible, code-switching | built |
| The assistant is actually audible on a phone call | **built and proven** — needed a third-party voice; Telnyx's own TTS renders nothing on PSTN (`telnyx-bug/`) |
| Voices chosen on measured latency, English and Dutch first | built — AWS Polly Joanna-Neural ~300ms, Azure Fenna ~396ms |
| Call time configurable, default 08:00 *(was: 07:00)* | built |
| Timezone always from the machine, not configurable at all *(was: guessed from dialling code and editable; briefly a searchable picker)* | built |
| Decline the call and ring the number back for the same brief | **built and proven** — 19 Aug, a 14-minute ring-in; its end was never reported until the inbound status callback was added the same night |
| Language chosen at setup, English default, Dutch second, ten total, stored per account | **built and proven** — Dutch calls on 19 Aug, once the CLI stopped defaulting to `en` |
| A way to trigger a demo call immediately | built — `screenless test` |
| 28 countries, with a fraud blocklist and a 0.25 USD/min rate cap *(was: worldwide; before that NL only)* | built — config, code and carrier profile reconciled |
| Sessions last a year | built |

## The paper

| Intent | Status |
|---|---|
| Delivered by Resend *(was: over whatever messaging MCP is connected)* | **built and proven** — domain verified, multiple emails received |
| Free; only the call is paid *(was: both behind the trial)* | built |
| Sent to one confirmed email, bound to the account | **built and proven** — confirmed on two accounts |
| A deep dive on how one area works today, from real codebase research | built, unrun |
| No charts of files or lines changed per PR — visualise schemas, data models, API surfaces instead | built, unrun |
| The nightly run schedules the call | **built and proven** — 19 Aug hand-run parked a brief for 08:00 and queued the paper for 07:45; the first attempt rang the phone at once instead (bare `--at` bug, fixed) |

## Install and loop

| Intent | Status |
|---|---|
| One command, bun-style: `curl -fsSL https://screenless.sh/install \| bash` | built |
| The landing page's job is to action developers into that command | built |
| The landing page should argue the problem, not assume it — who it is for, the wow moment, the objections | **built and live** — rewritten and deployed in session 5 |
| The page should be findable and quotable: link preview, structured data, canonicals, sitemap, `llms.txt` | **built and live** |
| robots.txt allows everything, `ai-train` included — being quoted by an assistant is acquisition | built and live — replaces Cloudflare's managed file |
| Setup verifies the phone, then takes payment if unpaid | built |
| Worker URL defaults to ours; self-hosted is a `y/N` question | built |
| The installer also installs the loop into Claude, globally | built |
| Setup offers the repo you are standing in, else points at `screenless init` | built |
| The loop is armed inside a Claude Code session, like the orchestrator: `screenless wait` blocks until 03:00 or a finished call, `/loop 1h` heartbeat; no scheduler, no `claude -p` *(was: launchd at 03:00 plus a 5-minute collector, both running `claude -p`; four nights, nothing produced)* | built — armed once; first real wake due 20 Aug 03:00 |
| Runs at 03:00, or first thing when the laptop opens | built, unrun — the waiter's `sleep` resumes on wake and stamps before building |
| The installer ships `press/` beside the skill, and removes the launchd jobs an older install left | built and run on one machine |
| One skill for both surfaces, plus the return leg | built |

## The return leg

| Intent | Status |
|---|---|
| After the call, results reach the machine as fast as possible | **built and proven** — the waiter woke within a minute of the call ending |
| Nothing lost if the laptop never wakes | built — the Worker keeps the transcript 24 h; the transcript email that proved this in session 2 was removed at the user's request in session 6 |
| The machine acts on the decisions | **built and proven** — 19 Aug: comments on #792 and #791 from the transcript, merges withheld |
| A proactive inbound call is acted on just as fast | built, unrun — the collector keys on "newer than last applied", not on expectation |
| A comment the apply leg writes on a pull request is signed, and names the tickets it already opened | built, unrun — `<!-- ☎️ screenless call <id> -->` plus an `Already ticketed:` line, added in session 8 after the nightly orchestrator read an unsigned one as a person and opened a second ticket for the same question |

## Money

| Intent | Status |
|---|---|
| $99/month, 7-day trial, card required, Stripe | built and proven with a real payment |
| Test mode first | built |
| Terms and privacy pages, accepted at setup | built |
| MIT licence | built |

## Process

| Intent | Status |
|---|---|
| Record every prompt verbatim in `intent/`, topped up during the session | built — and extracted into its own product, the [intent](https://github.com/janwilmake/intent) skill, in session 7: seeding from transcripts, authorship, inline sources, a weekly summary contract, and a pre-push gate |
| No API keys or private details in the repo | built |
| Do ops work in the browser rather than handing back instructions | built |
| Sign in as `wijnand@hyre.io` via Google SSO for Resend and Telnyx — **not** Cloudflare | built |
| Push to `main`, commits grouped by intent | built |

---

## Missing intent

Things asked for that the product does not yet do.

1. **`rounds` — the actual product.** Pull-request ingestion, cross-repo
   triage, agenda building, the "this needs your eyes" router. Session 1's
   entire premise. What exists is `screenless call "<prompt>"`, the primitive
   underneath it. Everything else in this document is packaging.
2. ~~The return leg has never run.~~ Ran on 19 August from the call that
   rang early: two decisions commented on #792 and #791, nothing merged.
3. ~~The site is not redeployed after session 6.~~ Deployed later that
   session, Worker too.
4. **The deep dive and the new figures are unrendered.** Written into the skill
   after you read the first paper; no edition has used them.
5. **"Up to 30 minutes of call a day"** is on the pricing page and enforced
   nowhere — the code counts 20 calls an hour and no minutes at all.
6. ~~The Dutch number is still blocked.~~ Cleared on 19 August; calls come
   from +31 85 083 5195 since session 6, and it can be rung back.
7. **Stripe is in test mode**, so no one can actually pay.
8. **Multi-repo** is supported by the registry and untested.
11. **The portal step for ring-ins is manual.** The Call progress events URL
   on the inbound TeXML app was set by hand on 19 Aug; a self-hosted Worker
   needs the same click (`/admin/inbound-url` hands out the URL).
12. **A leftover assistant TeXML app** (`ai-assistant-a3451229…`) sits on the
   Telnyx account from a call whose cleanup never ran; harmless, worth
   deleting.
9. **Parking has only been done by writing KV directly**, which skips the
   session and subscription checks the CLI goes through. The cron placing a
   parked brief is the last untested link in the chain.
10. **Two API keys were pasted into a chat transcript** on 15 Aug and need
   rotating. The reminder was removed from TODO when it was trimmed.

## Assumptions

Decisions taken without a specific instruction. Each is a place where I guessed
at what you wanted; any of them can be reversed cheaply.

**Security and spend**

- Rate limits: 20 calls/hour, 12 editions/hour, 5 OTPs per number/hour, and the
  global SMS ceilings of 60/hour and 300/day. All invented.
- `BLOCKED_PREFIXES` — which dialling codes are refused outright. Chosen from
  known SMS-pumping and satellite ranges; Latvia and Bosnia were removed again
  as too aggressive for a European product.
- The 110-country Telnyx verify whitelist.
- One free trial per phone number, ever.
- Retention: call records and transcripts 24 hours, parked briefs 48 hours,
  outbox 7 days.
- Using `.admin-secret` for `ADMIN_SECRET` and generating a fresh
  `SESSION_SECRET`, because `.dev.vars` held `local-…` placeholders.

**Product shape**

- Which ten languages, and one hosted voice per language. You asked "there are
  10 right?" — I picked the set the transcription side actually supports and
  chose the voices.
- The AI-disclosure greeting wording, in all ten languages.
- `~/.screenless/projects.json` and the `.screenless.json` schema — the whole
  three-file split of skill, project config, and machine registry.
- The `schema` and `table` figure types: you said "db schemas or data models or
  api schemas or whatever", I chose what "whatever" meant and how they draw.
- The demo brief `screenless test` reads out.
- Ungating `/mail` — you chose free-paper pricing; removing the paywall from
  that endpoint was my inference from it.
- Parking a brief **held** rather than scheduled when the loop catches up after
  the call time has passed.
- The five-minute collector interval, the `204`-when-nothing-new protocol, and
  the decision that merging needs a second gate while comments and labels do
  not.
- The landing page rewrite: what to cut, and using the call itself as the proof
  rather than a description of it.

**Words**

- Every line of the terms and privacy pages beyond "simple pages, accepted at
  setup" — including naming **W** as a Dutch sole proprietorship and putting
  disputes in Amsterdam, inferred from session 1.
- The landing page's design-partner framing and all marketing copy — including,
  from session 5, every FAQ answer and the choice of `screenless test` as the
  thing to put in front of a stranger first.
- `GTM.md` beyond the four choices you made: the phasing, the gates, the
  metrics, and the risks.
- Commit messages, and this document's structure.

**Things I changed without being asked**

- Corrected `rounds/README.md` and the README example, which still described
  the call as merging and commenting.
- Removed the country-code timezone guess entirely once the machine timezone
  made it redundant.
- Deleted the checked-in launchd plist in favour of generating it; then, in
  session 6, deleted the generated one too — the whole scheduler — once it was
  clear it could never have worked from outside a session.
- Put the waiter in the CLI as `screenless wait` rather than a second
  downloaded bash script, and made it stamp the night on handoff rather than
  leaving that to the model.
- Genericised the settings example in the skill, which carried real Hyre values.
