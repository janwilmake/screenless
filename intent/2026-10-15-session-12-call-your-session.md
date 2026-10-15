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

- **Hanging up.** The voice could not end a call. Now the line hangs up by
  itself, on both voices, but only after both sides said goodbye (the caller
  first, or "you can hang up"), and only once the caller stays quiet for 2.5 s;
  any further speech cancels it (`worker/src/farewell.ts`). It is kept narrow
  on purpose: answering-machine detection once hung up on real people.
  Verified on a live call: the voice said "Goodbye." and the call ended 3 s
  later, where the caller script would have stayed on for a minute. The
  Realtime side (outbound calls, quiet ring-ins) hangs up through
  `/v1/realtime/calls/{id}/hangup`; that path is untested.

- **The voice knows the session at pickup, and its name.** The watcher keeps
  a brief of the session on this machine (`cli/src/brief.ts`): (A) its title,
  recent prompts and replies read from the session log, plus git state; (B)
  condensed by haiku when the session changes. The brief is handed to the
  voice as background notes while it says the greeting. (C) A fork of the
  session adds its own summary 10–20 s in. Pickup never waits for any of it,
  and the brief never sits on a server between calls. `--name cody` makes the
  voice answer as Cody ("Hi Wijnand, Cody here"). Verified on a call: "where
  are we, and what is the code word?" was answered from the brief, with no
  handoff.
  Found on the way: the session text said "just reply OK", haiku obeyed, and
  the brief became "OK". The session text is now marked as data, and a brief
  that short falls back to the raw one. Goodbyes also had to count in either
  order (the voice's "Bye!" was transcribed before the caller's).
- **Test rings are pinned.** Earlier test calls reached the owner's real hyre
  watcher, and one was answered by a fork of that session. `test-ring` now
  needs `repo`: only the watcher in that repo may serve the call, and the
  finished call is not queued.

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

> cool. another adddition that would be nice, is for screenless to have the
> ability to hang up. they cant now it seems

> another question: when an incoming call comes in, would it be possible to
> give any initial context upon picking up from the claude session? what are
> our options here? ideally we'd have some session context and maybe other
> context ready immediately and update that context so it always knows whats
> going on a bit more already before picking up i think... wydt?

> one more question: my session is addressable in slack as 'cody' so it'd be
> great if it also knows its name is supposed to be cody, not 'claude
> session'. can this be done? yes, i like u to build A+B+C this wouldnt slwo
> down pickup time right?

> is it also pushed?
