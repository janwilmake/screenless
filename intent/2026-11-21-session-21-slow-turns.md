# Session 21 — the outbound voice waited too long to answer

author: Jan, via Claude Code in the screenless session

## Prompts

> screenless is v/slow

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

Open: whether "medium" brings back the echo self-cancel on speakerphone
(`realtime response ended … turn_detected` in `wrangler tail`).
