# TODO

## Blocks a real launch

- [ ] **`rounds` doesn't exist.** PR ingestion, triage, agenda. `loop/SKILL.md` describes it and has never run.
- [ ] **Stripe is test mode.** Live product + price + webhook, then swap 3 values.
- [ ] **Rotate the Telnyx and Anthropic API keys.** Both pasted into a chat transcript.

## Never run end to end

- [ ] Cron placing a parked brief. Parking has only been done by writing KV directly, which skips the session and subscription checks.
- [ ] Multi-repo: the registry supports it, nothing has tested it

## Backlog

- [ ] **Other coding agents.** The loop is Claude Code only — `SKILL.md` is Claude's
      format and `nightly.sh` shells out to `claude -p`. Nothing in the architecture
      requires it: the Worker takes text and a PDF and does not care what wrote them.
      Cursor / Codex / Amp would each need their own thin runner.

## Small

- [ ] The SMS ceilings log when tripped, but nothing pages anyone
- [ ] `captureTranscript` deletes the Telnyx conversation, which is also the
      evidence for debugging a silent call. Consider keeping it when a call
      produced zero assistant turns
- [ ] 30 min/day is sold on the pricing page; code counts 20 calls/hr and no minutes at all
- [ ] "Worldwide dialling" on the pricing page is 28 countries
- [ ] No alerting when the cron sweep throws
- [ ] No local `screenless` session on this machine — installer has never been run here

## Done

MIT licence · recipient bound to a confirmed address · global SMS ceilings ·
revocable sessions · transcripts deleted at Telnyx · install one-liner · Stripe
trial paywall (live-tested) · call scheduling · machine timezone · 10 languages ·
year-long sessions · terms + privacy with acceptance at setup · free paper /
paid call · intent record · 28-country dialling with a fraud blocklist and rate
cap · third-party voices chosen on measured latency · outbound call end to end ·
inbound call answered · Resend sending · the Telnyx silent-call bug, which was
their hosted TTS rendering no audio on PSTN (`telnyx-bug/`).
