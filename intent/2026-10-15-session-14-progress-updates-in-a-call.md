# Session 14 — progress updates into a live call

author: Jan Wilmake (spoken on a phone call), via the hyre loop session
(Claude Code, unattended agent)

What landed:

- **`screenless update [<callId>] "<text>"`** says a short progress note in
  the live call going on now. It posts to a new Worker route,
  `POST /live/<callId>/update`, with the same bearer auth and the same owner
  check as the answer path (`/live/<callId>/result`). `current` as the call id
  is the caller's own call in progress (the `livecall:` slot), so an agent
  that was never told the id still reaches it.
- **The fork knows its call.** `runFork` puts `SCREENLESS_CALL_ID` and
  `SCREENLESS_REQUEST_ID` in each live request's environment, so a fork, and
  any agent it starts, runs the plain `screenless update "<text>"` and the
  note is tied to that request's delegation.
- **Said at a natural moment, never as the answer.** The Durable Object sends
  it as `session.commentary.append` on the request's own delegation id.
  OpenAI's client-delegation guide allows several commentary appends per
  delegation and uses them for spoken "still working" updates; none closes
  the delegation, so the final answer still arrives and is said. Not
  `session.instructions.append`, which the same guide says can cut the
  voice's speech off. It waits for the caller to pause (700 ms, as the
  greeting does), and goes in silently as thinking if no pause comes in 10 s.
  At most one spoken update per 15 s per call; one sooner is passed on as
  thinking. Updates for a request already answered, and on a teammate's call,
  are refused. The voice's instructions say a "Still working on it" note is
  progress, said in one sentence at a pause, with the result still to follow.
- **The gate allows it** in restricted calls too, as one plain command whose
  text is plain words or quoted (no `$(...)`, no chaining). The fork's phone
  rules tell it it may send one for work over about 20 seconds, briefly, at
  most one every 20 seconds or so, and never instead of the answer. The
  screenless skill says the same.

Checked: the gate table (73 CLI tests pass, 6 new rows); the Durable Object's
update path, bundled with esbuild and driven with a fake voice socket —
commentary on the delegation when the caller is quiet, held while they talk
and sent after the pause, thinking when too soon, a null delegation id after
a voice restart, refused when answered, unknown, empty, a teammate's call or
ended. Both typecheck. Deployed: version
b8796ad8-8a16-4d66-bbc3-c88d94e50cdf. CLI and skills reinstalled on this
server from screenless.sh.

Still open:

- Not heard on a call yet. Whether GPT-Live says a progress commentary at the
  next pause, and does not take it for the answer, is the guide's promise,
  not something seen here.

## Prompt

> Feature request from the owner (spoken on a phone call): when a Claude Code session sends an agent off to do work during a live screenless call, that agent should be able to send interim progress updates into the ongoing call, so the voice model can tell the caller "still working, I found X" before the final answer arrives. Today screenless has no way to push a message into a call that is in progress; only the final answer gets spoken.
>
> Build it:
> 1. Find how a call's request reaches the session and how the final answer goes back to the voice model (Worker endpoints, CLI commands, call/session ids).
> 2. Add a Worker endpoint plus a CLI command (for example `screenless update <call-id> "<text>"`, or one that picks the active call automatically) that injects a short progress message into the live call. The voice model should speak it at a natural moment, not cut the caller off, and it must not end the turn or replace the final answer. Keep the same auth as the existing answer path.
> 3. Update the screenless skill (skills/ and the installed copy under ~/.claude/skills/screenless) and the call-handling instructions so a session on a call knows it may send interim updates, briefly, for work that takes longer than about 20 seconds.
> 4. Test it as far as practical, deploy the Worker with the existing wrangler login, and reinstall the CLI on this machine, as the previous PIN-flow agent did.
> 5. Never print or commit secrets.
>
> When done, report in a few sentences: what you built, the exact command to send an update, whether it is deployed, and how the owner can test it on the next call.
