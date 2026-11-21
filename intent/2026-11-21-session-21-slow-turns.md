# Session 21 — the outbound voice waited too long to answer

author: Jan, via Claude Code in the screenless session

## Prompts

> screenless is v/slow

> [from the hyre-36 session, at the user's request] Bug: a long outbound
> brief call lost its transcript after 12 minutes, but the phone call went on
> for 14 more minutes. […] Suggested fixes: log the close code and reason;
> on close while the call is still live, attach to the control socket again;
> make `screenless call` wait as long as the call actually lasts; optionally
> record the audio or flag a gap.

## What was found

Asked during a live outbound `screenless call` (a 13-goal interview of short
answers). The CLI starts in ~30 ms and the Worker answers in ~100 ms, so it
was neither. Outbound calls run on `gpt-realtime-2.1` with `semantic_vad` at
`eagerness: "low"`, set on 22 August to stop speakerphone echo cancelling
replies. Low eagerness also means the longest end-of-turn wait (up to ~8 s),
so every "yes" or "skip" was followed by a dead gap.

## What landed

- Lead mode (outbound calls) uses `eagerness: "medium"` (~4 s); quiet mode
  (ring-ins leaving a request) keeps `"low"` so a pause to think doesn't end
  the turn.
- Deploy held until the live call had ended, since a deploy restarts the
  Durable Object recording its transcript.

- The same call (22fe0cd8) kept only 10:09–10:22 of a call that ran to
  10:35: the Realtime recorder's control socket closed, or its object was
  evicted, and nothing reattached. No deploy happened in that window; why the
  socket went is unknown because nothing logged it.
- The recorder now logs every close (code, reason) and refused attach, keeps
  its start in storage, and runs a 30 s alarm that reattaches while the D1
  record says the call is live, resuming from the lines already in D1. It
  stops when the call ends, or after 3 hours.
- Each line now updates only the transcript column. The whole-row put it
  replaced could have undone a `completed` written between its read and write.
- `screenless call` (and `--to`, `transcript --wait`) give up on an
  unanswered call after 15 minutes as before, but wait out an answered one
  (cap 3 hours). It had exited mid-call at 15 minutes.
- Not done: recording the audio, or flagging a gap in the transcript.
  Recording is a privacy and cost decision for the owner.

Open: whether OpenAI accepts a second attach to a SIP call's control socket
after the first closed; unproven until a real call drops. Whether "medium" brings back the echo self-cancel on speakerphone
(`realtime response ended … turn_detected` in `wrangler tail`).
