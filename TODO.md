# TODO

## Blocks a real launch

- [ ] **`rounds` doesn't exist.** PR ingestion, triage, agenda. `loop/SKILL.md` describes it and has never run.
- [ ] **Telnyx silent-call bug** — no status since 15 Aug 09:32. If unfixed, nothing works.
- [ ] **Stripe is test mode.** Live product + price + webhook, then swap 3 values.

## Never run end to end

- [ ] Cron placing a parked brief
- [ ] A real inbound call to +1 641 215 3640
- [ ] The nightly loop, once, against hyre
- [ ] A Resend send — domain still `Pending`, DNS is live and correct

## Backlog

- [ ] **Other coding agents.** The loop is Claude Code only — `SKILL.md` is Claude's
      format and `nightly.sh` shells out to `claude -p`. Nothing in the architecture
      requires it: the Worker takes text and a PDF and does not care what wrote them.
      Cursor / Codex / Amp would each need their own thin runner.
- [ ] Multi-repo: the registry supports it, nothing has tested it

## Small

- [ ] 30 min/day is sold on the pricing page; code counts 20 calls/hr and no minutes at all
- [ ] No alerting when the cron sweep throws
- [ ] No local `screenless` session on this machine — installer has never been run here

## Done

Install one-liner · Stripe trial paywall (live-tested) · call scheduling ·
machine timezone · inbound answering · worldwide dialling with a fraud
blocklist · 10 languages · year-long sessions · terms + privacy with acceptance
at setup · free paper / paid call · intent record.
