# Intent, resolved

Last updated: 2026-08-21 — covers sessions 1–9, through the 18:40 prompt in
session 9. If the session files carry prompts newer than that, this document
is behind them and they win.

Every instruction given across all sessions, collapsed to its final form —
where an instruction was later replaced, only the replacement is listed, with
the superseded version noted so the reversal is not lost. Then checked against
what the code actually does.

Status: **built** = in the product and exercised · **built, unrun** = in the
product, never executed against reality · **not built**.

## The goal

A phone line and a nightly paper for teams whose coding agents work overnight.
Session 9 widened the "who": not one engineer but a team — one shared balance,
one number to ring, and every call routed to whichever teammate's terminal is
watching. The assistant on the phone still takes no action; the terminal does.

## The product

| Intent | Status |
|---|---|
| Get the decisions coding agents are blocked on out of a screen and into a phone call | not built — `rounds` does not exist |
| A nightly printable paper about your own product | built, unrun end to end |
| The paper and the call built together from one reading *(was: two loops)* | built, unrun |
| The phone assistant takes **no** action; the transcript goes to a terminal on the user's own machine, which acts | built |
| The watcher exits the moment it receives a call, so the agent session is woken; the *loop* re-arming it is what never ends *(was: a terminal process that never ends — reversed once it was clear a process that never exits can never reactivate the model)* | **built and proven** — three real spoken requests plus a synthetic one delivered; exit-on-delivery verified |
| One Worker on the apex: landing page, team page and API together; the site Worker deleted *(was: screenless.sh + api.screenless.sh as two Workers)* | **built and proven** — merged, deployed, all surfaces answering; api.screenless.sh kept as an alias for old CLI configs |

## Teams

| Intent | Status |
|---|---|
| Organizations and users in a database; one org per user, joining a team means leaving the last | **built and proven** — D1; accept flow moved a user in production |
| Cloudflare SQLite chosen by the agent *(offered: D1 or a Durable Object)* | built — D1, because the roster and billing tabs are queries |
| One page at screenless.sh/team — sign-in, roster, invites, accept flow and billing as states of a single document | **built and proven** — exercised in the browser end to end |
| Invite by **email only**; the invitee fills in and verifies their own phone on accept *(was: admin enters phone and email, invite by text + email)* | **built and proven** — invite sent, accepted, member created pending phone |
| A wrongly typed phone must never strand anyone: re-enter and re-verify any time, before or after accepting | built — the pending number lives server-side until verified; "change your number" re-runs the same flow |
| A reminder email a day later if the phone is still unverified — email only, once | built, unrun — cron sweep, marked before send |
| Invites valid seven days; expired ones still shown as that person, marked expired | built — expiry state exercised only as "fresh" |
| The page shows who invited you, by name and email | **built and proven** |
| Roster shows members and pending invites with invited-when; creator is admin; only admins add, remove, change roles | built — remove/role paths written, not yet clicked in production |
| A plus button and email field is the whole add flow | **built and proven** |

## Money

| Intent | Status |
|---|---|
| Billing per organization, pay-as-you-go: ~$10 free credit up front, then usage *(was: $99/month, 7-day trial, card up front)* | **built and proven** — $10 granted on first sight in production |
| Price at roughly double the cost | built — 30¢/min (`PRICE_PER_MINUTE_CENTS`), against ~7–15¢ COGS |
| Billing tab, visible to admins only: credit used and left, per-day statistics, who calls/costs most | built — rendered live with the grant; call stats have no calls to show yet |
| Topping up | built — Stripe Checkout one-time payments; sandbox page reached, no payment completed; webhook + poll-reconcile both credit idempotently |
| Calls debit the org by the minute when they complete | **built and proven** — a 50s demo call billed 25¢ and two ring-ins 11¢ and 8¢, all in the ledger |

## The call

| Intent | Status |
|---|---|
| A ring-in gets a robot voice, not the assistant: "Press 1 to speak to the assistant or start talking to make your request." *(was: ring-ins always answered by the assistant)* | **built and proven** — three real ring-ins on 21 Aug; the first two found the bug (TeXML never calls a Record's action URL on hangup; the recording only arrives via recordingStatusCallback) |
| Press 1 = the assistant with the parked brief, the same context as the morning call | built, unrun since the IVR rewrite |
| No keypress = a recording, transcribed, delivered as a request to the team's terminal — not a conversation | **built and proven** — two spoken requests transcribed by Telnyx Whisper and delivered |
| Requests route to the right terminal: your own first (earliest if you have two), else any teammate's watcher | **built and proven** — synthetic call exercised own-first, standby and dead-watcher failover; two real requests then routed live |
| Nothing gets lost when no watcher is up: the next watcher to spawn drains the backlog, one by one or in parallel as the agent chooses | built — queue holds seven days; `--gate` leaves a call unacked until `screenless done`, so it is re-handed rather than dropped |
| Three items per call, dossier-shaped; assistant answers from the brief and says when it cannot | **built and proven** — the 22:10 call on 19 Aug |
| Hang up on voicemail rather than brief it | **built and proven** |
| CLI: `call "<prompt>"` blocks and returns the transcript | built |
| Auth by phone number + OTP; only ever dials the verified number | built |
| Calls come from the Dutch number and it can be rung back | **built and proven** |
| Telnyx, EU media anchoring, third-party voices chosen on latency, ten languages | built |
| Call time configurable (default 08:00); timezone always from the machine | built |
| Sessions last a year | built |

## Look and mail

| Intent | Status |
|---|---|
| A logo: an S of two half circles, a dot centred in each bowl; iterate by looking | **built** — chosen from rendered variants; ink stroke, rust dots, survives 16px |
| The logo and the name on every email, professional HTML, never raw markdown | built — one branded frame; the loop's markdown reports render through a small md→html pass; codes, invites, reminders, paper and reports all covered |
| The team page looks smooth, with the logo and the site's palette | **built and proven** — screenshots in session |
| Landing page argues the problem; findable and quotable | built and live — pricing section rewritten for pay-as-you-go |

## The paper

| Intent | Status |
|---|---|
| Delivered by Resend to one confirmed email, bound to the account | **built and proven** |
| Free; only the call is paid | built |
| Deep dive from real codebase research; structural figures, no churn-per-PR charts | built, unrun |
| The nightly run schedules the call | **built and proven** |

## Install and loop

| Intent | Status |
|---|---|
| One command: `curl -fsSL https://screenless.sh/install \| bash` | built |
| The loop is armed inside a Claude Code session; `screenless wait` is the gate | built — proven for the nightly; `screenless watch --gate` armed beside it is new and unrun |
| The installer ships `press/` beside the skill | built |
| After the call, the machine acts on the decisions | **built and proven** |
| A PR comment the apply leg writes is signed and names what it ticketed | built, unrun |

## Process

| Intent | Status |
|---|---|
| Record every prompt verbatim in `intent/`, topped up during the session | built |
| Do ops work in the browser/CLI rather than handing back instructions | built — D1 created, Workers merged and deployed, page exercised live this session |
| Push to `main`, commits grouped by intent | built |

---

## Missing intent

Things asked for that the product does not yet do, or has not yet proven.

1. **`rounds` — the actual product.** Pull-request ingestion, cross-repo
   triage, the "this needs your eyes" router. Session 1's premise, still
   packaging ahead of product.
2. **The press-1 assistant path is the last unrun leg of the line.** The
   record-a-request path, transcription, routing, debit and the watcher
   hand-off were all proven with real calls on 21 Aug; connecting a ring-in
   to the parked brief's assistant has not run since the IVR rewrite, and the
   first morning where someone declines the call and rings back is its test.
3. **Stripe is in test mode**, so a topup cannot actually be paid. The old
   webhook endpoint also still subscribes to subscription events and may not
   subscribe to `checkout.session.completed` — unverified; the billing page's
   poll-reconcile covers the gap either way.
4. **The deep dive and new figures are unrendered**; no edition has used them.
5. **Old-model leftovers in Stripe/KV**: the $99 product, test subscriptions
   and `sub:`/`pending:` KV records are dead weight, harmless but unswept.
6. **The pending invite left by this session's test** — jan@wilmake.com sits
   in "My team" as a phone-unverified member; tomorrow's cron will send the
   first real reminder email. A live test, but also cleanup nobody asked for.
7. **The privacy page still promises transcripts gone in 24 hours**, while a
   queued team call now keeps its transcript up to seven days so it cannot be
   lost. The page needs a sentence, or the retention needs a rethink.
8. **Multi-repo watch routing is blunt**: the watcher reports its repo but
   assignment ignores it — a request about repo A can land in a terminal
   watching repo B if that is the only one up.
9. **Two API keys pasted into a chat transcript on 15 Aug still need
   rotating.**

## Assumptions

Decisions taken without a specific instruction, each reversible cheaply.

**Money**

- 30¢/minute as "about double the cost", and $10.00 exactly as "give or take
  $10"; both are wrangler vars.
- Topup buttons at $10 / $25 / $100, custom amounts only via the API; bounds
  $5–$1000 per topup.
- Billed per second at the minute rate, only for **completed** calls — a
  no-answer, a voicemail, or a menu hang-up costs the org nothing.
- A call is allowed to push the balance below zero; the gate stops the next
  call, not the one in flight.
- One free grant per org, ever; a member removed from a team is parked in a
  fresh solo org with **zero** credit rather than a second $10.
- No card at setup at all — the trial's "card up front filters for intent"
  logic died with the subscription.

**Teams**

- The web session is a 30-day cookie keyed by user id, signed with the same
  secret as CLI tokens but not interchangeable with them.
- Sign-in is an emailed 6-digit code; the answer never says whether an address
  has an account.
- Re-inviting an email replaces the old invite and restarts the seven days —
  that is also what "resend" does for an expired one.
- The last admin can neither be demoted nor leave for another team without
  appointing a successor; admins cannot remove themselves.
- A CLI-first user gets an org named "My team" created silently on first
  sight, and their confirmed paper email doubles as their team-page sign-in.
- An invitee who runs `screenless setup` instead of finishing on the web is
  matched onto their invited row by email, not given a rival org.

**The line and the watcher**

- The robot greeting is Jan's sentence plus "after the tone", because the
  gather has to time out (3 s) before the beep starts and words spoken before
  it are lost.
- Ring-ins are answered only for verified members of a funded org; strangers
  and empty balances get one sentence and a hangup.
- Recording caps at 5 minutes, ends on `#` or 6 s of silence; transcription is
  Telnyx-hosted Whisper, inline, so "Got it" is only said once the text is
  stored.
- Watcher heartbeats live 90 s; polls every 10 s double as heartbeats; ties in
  routing break by earliest start, then id.
- Queued calls are capped at 50 per org and their records kept 7 days;
  nothing is ever acked on display — only `screenless done` after the work
  ran, so every call is at-least-once *(was: a display mode that acked on
  print, dropped with the never-ending default)*.
- The `WORK <callId>` line and the two-gate arming (`wait` + `watch`) in the
  loop skill are my wiring of the watcher into the existing session contract.

**Look and words**

- The logo: 248° arcs (270° read closed, 225° read as an 8), ink stroke, rust
  dots, the site's palette; the wordmark stays lowercase serif. The old
  data-URI newspaper favicon was replaced by it.
- Email frame: hosted PNG logo (Gmail strips inline SVG), paper card on wash
  background, one rust button style; the md→html subset covers what the
  loop's reports actually use and degrades to paragraphs.
- Landing pricing copy, the "30¢/min · first $10 on us" framing, and the
  README economics rewrite.
- `api.screenless.sh` kept alive as an alias rather than migrating old CLI
  configs.

**Earlier assumptions that still stand**

- Rate limits (OTP 5/number/hour, 60/hour global, 300/day; 20 calls/hour;
  12 editions/hour), the fraud prefix blocklist, and retention windows
  (calls 24 h, briefs 48 h, outbox 7 days) — all invented in sessions 1–6.
- The ten languages and their voices; the AI-disclosure greetings.
- The three-file split of skill, project config and machine registry.
- The terms and privacy pages' wording; the landing page's design-partner
  framing; `GTM.md` beyond the four choices made.
