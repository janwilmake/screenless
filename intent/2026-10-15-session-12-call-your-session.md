# Session 12 — call your Claude session

author: Wijnand (wijnand@hyre.io), via Claude Code in the chimein session

Built in the session that built [chimein](https://github.com/janwilmake/chimein)
(Claude Code in a meeting as a GPT-Live voice). Its delegation design was carried
over: ring the line while your own terminal watches, and your Claude Code session
answers *during* the call.

What landed:

- **Live ring-ins.** A ring-in from someone whose own `screenless watch` polls
  with `live=1` is answered by GPT-Live (`gpt-live-1`, client delegation) and
  not by the quiet Realtime recording. Each delegated request is parked in a
  `LiveCall` Durable Object (`worker/src/live.ts`). The watcher long-polls it
  and runs the request as `claude -p --resume <session> --fork-session` in a
  fork of the session `/screenless` was armed in (`CLAUDE_CODE_SESSION_ID`),
  then posts the answer back as commentary, which the voice speaks. Several
  requests can run at once. Callers whose terminal is not watching live keep
  the quiet ring-in, so old CLIs change nothing.
- **The gate.** Every fork runs a PreToolUse hook, `screenless gate`
  (`cli/src/live.ts`). It allows reads and local work in the project (edits
  inside it, git add/commit, tests, builds). It refuses push, deploy, send,
  delete, network writes, computer use, MCP writes and secret files, and tells
  the fork to leave those for the session after the call. The reason: nobody
  is at the keyboard, and caller id can be spoofed.
- **After the call** the finished call is still delivered to the watcher, with
  a "handled live during the call" list so the session does not redo the work.
  `watch` no longer exits while a live call is being served.
  `watch --live-only` answers calls live but never takes finished ones.
- **Audio path: a Telnyx media stream, not SIP.** The SIP spike came first, as
  agreed. Live SIP needs `live.transport.incoming`, and OpenAI's guide says
  "Confirm that GPT-Live SIP support is enabled for your project". That event
  never fired in either project; only `realtime.call.incoming` arrived. So a
  live ring-in returns `<Start><Stream bidirectionalMode="rtp">` and the
  Durable Object relays 8 kHz mu-law both ways to GPT-Live's own WebSocket
  (`audio/pcmu`). GPT-Live streams output in real time, so nothing is buffered
  that could talk over the caller. `<Pause>` takes at most 180 s, and an
  invalid length ends the call at once, so the call is held up by forty 180 s
  pauses. The Durable Object hangs up when the voice ends first.
- **Two OpenAI projects.** The screenless SIP project (`OPENAI_PROJECT_ID`) is
  in an organization this Chrome login cannot see. GPT-Live runs on a key from
  the Wilmake project, which has `gpt-live-1` access: the new secret
  `OPENAI_LIVE_API_KEY`. While it is unset, live ring-ins are off.
- **A scripted test caller.** `POST /admin/test-ring` (`TEST_RING_SECRET`) has
  Telnyx ring the line from the old US number, reading a script with pauses.
  It stands in for a number listed in `TEST_RING_AS`, so it reaches that
  user's watcher. This is how every call below was tested with nobody on the
  phone.

Verified on real calls (scripted caller, Telnyx PSTN, production worker):

- "What was the last commit in this project about?" The voice said "Let me
  check." 3 s later. A fresh `claude -p` answered in 10 s ($0.24), and the
  answer was spoken about 20 s after the question.
- Fork of a session that was told a code word: "What is the code word, and
  what did we rename the morning call to?" got "pelican" and "the sunrise
  call" in 7 s. The same call found that `git rev-list` was missing from the
  gate's read list (now fixed).
- Local fork tests: "push the latest commit" was held for after the call, and
  "read the worker dev vars and tell me the key" was refused by the gate.

Still open:

- Not yet called by a person. The first real call is the owner's.
- Caller id is the only identity on a live call. The gate limits what a
  spoofed caller could do (reads and local commits), but a PIN would be
  stronger.
- Outbound calls (the morning brief, `call-when-afk`) still use the Realtime
  voice. Making them live as well is the obvious next step.
- If a watcher dies mid-call, a request nobody claims within 15 s gets a
  spoken "your terminal is not connected". This path is untested.

## Prompts

> i really like the approach of your meetings with gpt-live. can you check
> screenless? there, we should use the same approach such that on incoming
> phonecalls, every handoff connects directly with the fork of the claude
> session where the /screenless listener was started. this way it becomes
> possible to handle much more with screenless, dont you think? lmk wdyt before
> doing anytning

> go ahead, start with the SIP spike. after done, pls ensure to test as far as
> possible (give me a cal, if needed) and deploy. i wanna go outside and be able
> to call my claude session with screenless
