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

> btw also a new version of gpt live came out, can this be used? and can we
> leverage the cheaper cost if we arent talking

> i mean for calls, but also when in meetings. we need all of screenless to
> use this new model and leverage the price reductino

> btw do we still use openai realtime for anything? why? is this still needed?

> yes, lets get rid of realtime and move it all to gpt live 1.1

> explain the full screenless repo and archietecture as of right now in 1
> artifact

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

- GPT-Live-1.1 (same $0.05/min as 1) for live ring-ins and meetings, set
  once as `OPENAI_LIVE_MODEL`. Both paths fall back to `gpt-live-1` if the
  new model is refused, so a refusal costs the upgrade, not the call.
- Standby in meetings: `idle_timeout_s: 60`, `wake_policy: speech`. After a
  minute with no transcript either way it bills $0.02/min, and speech wakes
  it, so the bot still hears everything said (the session 20 decision). The
  docs give that rate to WebRTC sessions only: meetings are WebRTC, phone
  ring-ins are a WebSocket, so ring-ins have no standby. Undocumented: whether
  a delegation's answer wakes a paused session; logged as
  `meeting voice sent to while in standby`. If the config is refused, the
  meeting retries without standby.
- Realtime is gone. Outbound calls (`screenless call`, parked briefs, `--to`)
  and ring-ins with no watching terminal now run on GPT-Live through the same
  Telnyx media stream and LiveCall object as live ring-ins, marked
  `unwatched`: nothing is handed off, and a handoff the voice makes anyway
  is answered at once with "noted for after the call". A brief opens with an
  instruction (open the way the brief says), not fixed words; an unwatched
  ring-in waits silently for the caller. The leg's sids reach the config when
  it answers (`/texml/brief/:id`), which also marks the call answered.
- Deleted: the SIP bridge, the `realtime.call.incoming` webhook, RealtimeCall
  (migration v4) and its watchdog from earlier today, the eagerness setting,
  and `OPENAI_PROJECT_ID`, `OPENAI_SIP_HOST`, `OPENAI_REALTIME_MODEL`,
  `OPENAI_WEBHOOK_SECRET`. `OPENAI_API_KEY` now only transcribes WhatsApp
  voice notes. Every call needs `OPENAI_LIVE_API_KEY`.
- LiveCall's transcript writes now touch only the transcript column, as the
  Realtime recorder's did.
- The architecture page: https://claude.ai/artifact/KuuikeAh2XuxuAsUbFRGAW

- First outbound call on GPT-Live (c9e9bd02, 151 s): worked end to end,
  transcript complete. Asked on it: record outbound calls? Jan: no, not
  while the transcript fixes hold ("don't you think we already solved the
  problem"). Feedback: "this response just now, it took two seconds or so.
  So I think that's a bit too slow". Measured reply 1.5–1.7 s from his last
  loud frame to the voice's first audio, DO in FRA; plus the phone network.
  Interruption felt good. Many short `live barge-in` (by loud) while the
  voice spoke: likely its own echo clearing ~20–200 ms of queued audio.

Open: the remaining reply latency; the echo barge-ins. Whether GPT-Live keeps quiet on an unwatched ring-in the way
Realtime's no-auto-response mode forced it to.
