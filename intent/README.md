# intent

The prompts this repo was built from, one file per session, oldest first.

Git records what changed. This records what was *asked for* — which is the part
that gets lost, and the part you need when a decision looks arbitrary six weeks
later. A commit message can tell you the timezone is guessed from the dialling
code. Only the prompt tells you the instruction was "we can guess based on the
phone number country code, but u should be able to edit", which is why the guess
is labelled as a guess in the CLI instead of quietly assumed.

## Sessions

| Session | What it decided |
|---|---|
| [Session 1 — finding the product](2026-08-15-session-1-finding-the-product.md) | Vendor choice (Telnyx, EU anchoring), the phone-verified CLI, `press` as a nightly PDF, the rename from voxcall. Includes the upstream silent-assistant bug, and a long drift into outreach. |
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
