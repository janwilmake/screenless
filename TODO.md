# TODO

## Blocks a real launch

- [ ] Test: Cron placing a parked brief. Parking has only been done by writing KV directly, which skips the session and subscription checks.
- [ ] **Stripe is test mode.** Live product + price + webhook, then swap 3 values.

## Backlog

- [ ] Multi-repo: the registry supports it, nothing has tested it
- [ ] **Other coding agents.** The loop is Claude Code only — `SKILL.md` is Claude's
      format and the waiter is armed from a Claude Code session. Nothing in the
      architecture requires it: `screenless wait` is a plain command, and the Worker
      takes text and a PDF and does not care what wrote them. Cursor / Codex / Amp
      would each need their own thin harness around the same gate.
- [ ] **Subagents for the build.** The nightly read runs in the armed session's own
      context. Fine for one repo; when it gets heavy, have the tick hand the build
      to a subagent or a `cca` window and keep the armed session thin.
