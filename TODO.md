# TODO

## Blocks a real launch

- [ ] Test: Cron placing a parked brief. Parking has only been done by writing KV directly, which skips the session and subscription checks.
- [ ] **Stripe is test mode.** Live product + price + webhook, then swap 3 values.

## Backlog

- [ ] Multi-repo: the registry supports it, nothing has tested it
- [ ] **Other coding agents.** The loop is Claude Code only — `SKILL.md` is Claude's
      format and `nightly.sh` shells out to `claude -p`. Nothing in the architecture
      requires it: the Worker takes text and a PDF and does not care what wrote them.
      Cursor / Codex / Amp would each need their own thin runner.
