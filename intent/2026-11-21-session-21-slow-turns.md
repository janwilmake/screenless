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

> how can we make the reply speed faster?

> try it all and measure. goal is to just make the full exp better . tell me
> if you need me for any of the steps

> btw are we able to leverage the new pricing discount for inactive
> live-voice-sessions of 1.1? in meetings as well as calls?

> 1 can u ask them for me? then: worht! 2: how would this work, where would
> the openai api key live? 3: lets wait until the other 2 r done

> it can be max 600 chars so i couldnt send it. pls rewrite the note

> i guess #2 has to wait for this?

> ok build the outbound prototype and test it; if its better, keep it

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

- Measured with the scripted test caller (`worker/scripts/bench-ring.sh`,
  new `TEST_RING_SECRET`), five questions per call, unwatched path:
  - What the caller hears (dual-channel recording of the test leg): 1.5 to
    2.3 s from the end of a question to the answer, median ~1.9 s.
  - At the relay: ~1.35 s from the caller's last sound to the voice's first
    audio. Round trip from the relay (AMS) to api.openai.com 140 to 190 ms,
    to eu.api.openai.com 30 to 50 ms. So roughly: GPT-Live ~1.2 s, US network
    ~0.15 s, the Telnyx phone path ~0.55 s.
  - No change from: 16 kHz audio straight through instead of resampling to
    24 kHz (kept 24 kHz, `LIVE_AUDIO_RATE`); 12,000 characters of brief in the
    instructions (only the session start, +0.3 s); minimal "answer at once"
    instructions.
- Fixed: the end of the caller's question is transcribed ~0.5 s after the
  voice starts answering, and was taken for an interruption, clearing the
  start of the answer on every turn. A word barge-in now counts only for
  speech that began after the voice did. The loud barge-ins were the
  caller's own question clearing queued silence, not echo, as first thought.
- Per-turn timing is now logged on every call (`live turn`: replyMs,
  fromHeardEndMs, transcriptMs) with the US/EU round trip (`live rtt`).
- Standby on a phone call: OpenAI refuses it over a WebSocket,
  "idle_timeout_s requires a standard WebRTC session with wake policy
  support". Meetings (WebRTC) keep it; not yet seen in a real meeting.
- Asked of the Roost session, from Wijnand: screenless as the chief across
  all sessions on this Mac, with a brief ready before a call. To plan with
  him before building.

- Asked OpenAI sales (contact form, sent by Jan on 21 Nov) for EU data
  residency and inbound GPT-Live SIP on that project. With SIP the key stays
  a Worker secret: OpenAI's signed webhook announces the call, the Worker
  accepts it with the key and keeps a sideband for transcript and handoffs,
  and the audio skips the relay. The chief idea waits until both are done.

- Outbound calls over SIP, kept: GPT-Live dials the user itself through a
  new Telnyx credentials connection (`screenless-openai-sip`, SRTP,
  Amsterdam, the Default outbound profile), created through the API by
  `/admin/sip-trunk`; its SIP password is derived from SESSION_SECRET and
  never typed or shown. The Worker keeps only the sideband. Measured on the
  answering phone, same script: relay 1.46 to 1.69 s from question to
  answer (median 1.65), SIP 0.69 to 1.02 s (median 0.87). `LIVE_OUTBOUND`
  is "sip"; a failed SIP dial falls back to the relay, and briefs that need
  voicemail detection stay on the relay. Inbound still waits for OpenAI.
- Jan sent a login verification code in chat for the Telnyx portal; not
  entered (one-time codes are his), and the portal was not needed.

Open: OpenAI's answer on EU residency and inbound SIP; whether SIP
straight from Telnyx to OpenAI cuts the ~0.55 s phone path; standby seen
working in a meeting. Whether GPT-Live keeps quiet on an unwatched ring-in the way
Realtime's no-auto-response mode forced it to.
