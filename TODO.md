# TODO

## Blocks a real launch

- [ ] **`rounds` doesn't exist.** PR ingestion, triage, agenda. `loop/SKILL.md` describes it and has never run.
- [ ] **Telnyx silent-call bug** — still live, with Telnyx support. What is now known:
      the transcript of a completed call contains the human's turn and **zero
      assistant turns**, not even the greeting Telnyx speaks on answer. Ruled
      out: the model (two vendor families), the voice, the language, the
      endpoint (`/texml/ai_calls` and `/texml/calls` both), and this worker
      entirely. The assistant is created successfully and returns a TeXML app
      id, so it exists; it simply never runs.

      The `/texml/say` diagnostic is **done**: a plain `<Say>` call on the same
      number and connection was audible for 11s
      (session `d0ca2ae6-9886-11f1-9044-02420a1f0a69`), 60 seconds before a
      silent assistant call. That isolates the fault to the assistant, not the
      audio path.

      Also done: dropping the `Url` override so Telnyx serves its own
      `/ai/assistants/{id}/texml` document. Still silent
      (session `bd6742f2-98d3-11f1-af69-02420a1f0b69`, 2026-08-15 18:04 UTC) —
      placed by bare curl against a freshly created assistant, so no part of
      this codebase is in the path. It also reproduces from Telnyx's own portal
      button on their own unmodified `Blank` assistant.

      Only untried variable left: `external_llm` with our own OpenAI key, which
      takes a different inference path from Telnyx-hosted models.
- [ ] **Stripe is test mode.** Live product + price + webhook, then swap 3 values.

## Never run end to end

- [ ] Cron placing a parked brief
- [ ] A real inbound call to +1 641 215 3640
- [x] ~~An outbound call end to end~~ — placed, answered, transcript captured,
      stored, emailed to the Inbox. Only the assistant's audio is missing.
- [x] ~~The nightly loop, once, against hyre~~ — ran, produced an 8-page edition; parked nothing (no session at the time)
- [ ] A Resend send — domain still `Pending`, DNS is live and correct

## Backlog

- [ ] **Other coding agents.** The loop is Claude Code only — `SKILL.md` is Claude's
      format and `nightly.sh` shells out to `claude -p`. Nothing in the architecture
      requires it: the Worker takes text and a PDF and does not care what wrote them.
      Cursor / Codex / Amp would each need their own thin runner.
- [ ] Multi-repo: the registry supports it, nothing has tested it

## Small

- [ ] The SMS ceilings log when tripped, but nothing pages anyone
- [ ] `captureTranscript` deletes the Telnyx conversation, which is also the
      evidence for debugging a silent call. Consider keeping it when a call
      produced zero assistant turns

- [ ] 30 min/day is sold on the pricing page; code counts 20 calls/hr and no minutes at all
- [ ] No alerting when the cron sweep throws
- [ ] No local `screenless` session on this machine — installer has never been run here

## Done

MIT licence · recipient bound to a confirmed address · global SMS ceilings ·
revocable sessions · transcripts deleted at Telnyx · install one-liner · Stripe trial paywall (live-tested) · call scheduling ·
machine timezone · inbound answering · worldwide dialling with a fraud
blocklist · 10 languages · year-long sessions · terms + privacy with acceptance
at setup · free paper / paid call · intent record.
