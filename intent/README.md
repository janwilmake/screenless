# intent

The prompts this repo was built from, one file per session, oldest first.

Git records what changed. This records what was *asked for* — which is the part
that gets lost, and the part you need when a decision looks arbitrary six weeks
later.

The timezone is the example worth keeping. A commit log shows it guessed from
the dialling code, then made editable, then made a searchable picker, then
deleted outright in favour of reading the machine. Only the prompts show why:
"using the machine-set time is muuuuch better actually. lets simplify and make
this not configurable at all." Without that line the deletion looks like
scope-cutting rather than the simplification it was.

## Start here

[SUMMARY.md](SUMMARY.md) — every instruction collapsed to its final form and
checked against the code, with what is still missing and what was assumed
without being asked. Read that; read the session files when you need to know
exactly how something was worded.

## Sessions

| Session | What it decided |
|---|---|
| [Session 8 — two loops, one question, two tickets](2026-08-20-session-8-two-loops-one-question.md) | Two tickets for one research question, one minute apart: the apply leg opened one and the nightly orchestrator opened another off the same unsigned PR comment. Consolidated in Linear, and fixed on both sides — a PR comment is now signed `<!-- ☎️ -->` and names what it already ticketed. Also: the installed skill became symlinks into this repo. |
| [Session 7 — the intent convention becomes a skill](2026-08-20-session-7-intent-becomes-a-skill.md) | The folder graduates to [janwilmake/intent](https://github.com/janwilmake/intent): seed from transcripts per contributor, author on every file, inline intent sources, weekly summary contract, pre-push gate. This repo adopts it in the same sitting. |
| [Session 6 — why there have been no calls or emails, and the move in-session](2026-08-19-session-6-why-no-calls-or-emails.md) | Four nights of the 03:00 job, nothing delivered: launchd cannot read `~/Desktop` (TCC → EPERM), `claude -p` denies every Bash call unattended, and `press/` was never installed. Fixed by dropping the scheduler: `screenless wait` is the gate, the skill is armed in a session like the orchestrator, the installer ships `press/` and removes the old jobs. Later the same night: the first real calls, the brief cut to three dossiers with the assistant told to slow down, voicemail hung up on, the transcript email replaced by a mailed report, the Dutch number live, and the ring-in path closed properly. |
| [Session 1 — finding the product](2026-08-15-session-1-finding-the-product.md) | Vendor choice (Telnyx, EU anchoring), the phone-verified CLI, `press` as a nightly PDF, the rename from voxcall. Includes the upstream silent-assistant bug, and a long drift into outreach. |
| [Session 3 — the first real loop run](2026-08-15-session-3-first-real-loop-run.md) | A trial run against a real repo, in its own window. Produced an 8-page edition and a call brief; parked neither, for want of a session. Found the collector's silent PR undercount. |
| [Session 2 — the paywall, the installer, and the call's real boundary](2026-08-15-session-2-paywall-and-install.md) | `curl \| bash` install, Stripe 7-day trial at $99/mo, call-time and timezone settings, ring-back on a declined call, and the correction that the phone assistant takes **no** action. |

## Rules

- **Prompts verbatim.** Typos, drift and dead ends stay in. A cleaned-up
  instruction is a reconstruction, and reconstructions are where hindsight
  sneaks in.
- **A short header per session**, written after the fact: what landed in the
  code, and what is still open. That is the only editorialising allowed.
- **Answers to direct questions count as prompts** — a choice between options
  is intent, and is recorded inline where it was given.
- **No secrets.** Pasted logs and payloads get their keys, tokens and phone
  numbers redacted before they land here.

See [CLAUDE.md](../CLAUDE.md) for when to write these.
| [Session 5 — the landing page argument](2026-08-15-session-5-the-landing-page-argument.md) | The landing page rewritten to argue rather than assume: problem section, the `screenless test` wow moment, the no-credentials boundary, an FAQ, and the design-partner honesty promoted out of the fine print. Includes a mobile overflow bug that turned out to be headless Chrome's 500px floor. |
| [Session 4 — the silent call was Telnyx's own TTS](2026-08-15-session-4-the-tts-bug.md) | The bug that blocked every call since session 1: Telnyx-hosted TTS renders no audio on PSTN. All ten languages moved to AWS/Azure voices, chosen on measured latency. Includes the `<Say>`-then-assistant reproduction, and half a friction list retracted after checking the docs. |

## Seeded

| Contributor | Date |
| --- | --- |
| Jan Wilmake | 2026-08-20 — history was already recorded by hand from session 1; the seed scanner verified it and recovered one missed prompt (session 6, 20:32) |
