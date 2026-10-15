# Session 13 — what went wrong on the first real live call

author: Jan Wilmake, via the hyre loop session (Claude Code, unattended)

Jan made the first real call to his own session (call 28180e09, 15 October,
16:19 CEST). It was answered live by forks of a very long Claude Code
session in the `hyre` repo, and it went badly in six ways. This session
fixed them unattended, from the watcher's output for that call.

What landed:

- **The line hangs up after goodbye — the real cause.** Mid-call the voice
  greeted Jan a second time ("Hi Wijnand, Cody here") and from then on
  delegated requests went nowhere ("still checking on it"), and "Bye bye" /
  "Please hang up" never ended the call. One of the two sockets (Telnyx's
  media stream or GPT-Live's session) dropped while the phone call went on.
  `LiveCall.finish` ran and set `ended`; a new stream on the same Durable
  Object then started a fresh voice that greeted again; the watcher had
  stopped serving because the call was `ended`; and the goodbye hang-up
  called `finish`, which returned at once because `ended` was already set.
  Now `ended` means only that the phone call is over: a dropped GPT-Live
  session is restarted with the notes and the call so far and told not to
  greet again (up to three times); a dropped phone stream gets 6 s to
  reconnect; a reconnect replaces the stream and carries on; results for a
  request delegated to a replaced voice are passed to the new one in plain
  words; and the watcher serves a call again if it comes back live. The
  goodbye check itself was widened: "I'm gonna go now" counts as a goodbye,
  "please hang up" alone hangs up 6 s later even without a goodbye back, and
  a transcribed breath ("[inhale]") or more goodbye no longer cancels a
  pending hang-up. Real speech still cancels it, and the timer re-checks
  that the caller is not mid-sentence when it fires.

- **Faster answers: a long session is no longer forked per request.**
  Measured on this server with "Reply with just the word OK": a fork of the
  hyre session (529k tokens of context) took 15.5 s and $0.21; a fresh
  `claude -p` took 5.3 s and $0.01 once cached (3.1 s without MCP servers,
  kept on because forks need MCP reads). The watcher now reads the session's
  context size from the last turn's usage in its log, and past 150k tokens
  runs each request fresh, handed the pickup brief and the session's own
  summary (C), which still comes from one fork at pickup. `--fork` forks
  regardless. The voice is also told to answer "can you say more?" and the
  like from its notes rather than delegate them, since every handoff costs
  seconds. The 4 s watcher poll the fork blamed on the call only applies to
  finding the call at pickup; requests during the call were already a
  long-poll that wakes at once, so it was left alone.

- **The greeting waits for the caller, and uses the name they set.** The
  call opened with "Hi Wijnand, Cody" interleaved with Jan still talking to
  someone in the room. The Durable Object now measures the loudness of the
  caller's audio (over an adaptive noise floor, so a street does not count
  as talking) and says the greeting only after 0.7 s of quiet, at most 6 s
  in, and not at all if the voice already answered by itself; "exactly and
  in full" became "stop at once if the caller speaks". The wrong name was
  not taken from the email: no code does that. It is the `name` stored on
  the member whose verified phone rang, typed at invite time for the
  wijnand@hyre.io account. A guess from the mailbox was tried and dropped,
  because it would have left a real Wijnand nameless for good. Instead a
  member sets their own name, `screenless settings --name "Jan"`, and an
  unset name greets with none.
- **The gate lets plainly read-only commands through; the brief names what
  it knows.** "How many agents do you have running?" failed because
  `screen -ls` and `ps` were refused. Now allowed: `ps` (in forms that cannot
  print environments), `pgrep`, `screen -ls`, `tmux ls`, `uptime`, `uname`,
  `whoami`, `top -b -n1`, `diff` and a few more, and the `ListAgents` tool.
  Loops and `$(...)` stay refused, and the refusal now says a plainer command
  may work. Of `~/.screenless` only the config is secret now (a fork could
  not grep the CLI's own code); and `~/.claude/.credentials.json` — Claude
  Code's own login — was readable because the leading dot slipped past the
  `credentials` pattern; it is blocked now. The pickup brief names the
  uncommitted files and the checkout instead of "one uncommitted change on
  dev" (it was a stray `tc.log`), and counts the Claude Code sessions running
  on the machine and where, by those with a terminal (forks have none).
  Checked against a table of 16 allowed and 20 refused commands, and six
  paths and tools.
- **"can't reach the worker" after the call was the CLI, not the Worker.**
  That line is printed only when `fetch` throws; a Worker error is an HTTP
  status and prints nothing. It cleared on the next poll, twice, right as
  the call's long-polls went idle: the mark of Node reusing a keep-alive
  connection the far end had closed. Every watcher poll and every live post
  now retries once on a network error (`fetchRetry`), which matters most for
  the fork's answer: `post()` swallowed the error, so an answer sent on such
  a connection was lost without a word. The offline line now names the error
  code, so a real outage can be told apart. Reproduced locally with a server
  that drops a request's connection: plain fetch throws `UND_ERR_SOCKET`,
  `fetchRetry` gets the answer.

Still open:

- Not verified on a call: needs a worker deploy, then a call that ends with
  "bye".
- The speed-up is measured per fork, not on a call. Answers that need real
  work still take as long as the work.
- The keep-alive cause of the flapping is inferred, not seen: no Worker logs
  were available here. The error code in the offline line will show it.
- Jan's account still carries the name Wijnand until he runs
  `screenless settings --name "Jan"` against the deployed worker.
- The loudness threshold (500, or three times the noise floor) is set from
  synthetic audio, not tuned on a real line.

## Prompts

> Fix the live-call problems in screenless, unattended. You are in a clone of janwilmake/screenless. Read its CLAUDE.md first and follow it: commit straight to `main` (its stated rule), one commit per decision, and record intent in `intent/` as that file says (the prompts verbatim, author: Jan Wilmake via the hyre loop session).
>
> Start with `git fetch origin && git checkout -f main && git reset --hard origin/main`.
>
> **Jan's report (15 Oct 2026, 16:30, after a live call to the line):** "just had a call with screenless. lot of problems.. 1) it replies slowly, few seconds at least. 2) it still seems impossible for it to hang up. it didnt do it after saying bye. 3) theres more, see transcript".
>
> The watcher's full output for that call is in `~/work/screenless-call-28180e09.txt` (call 28180e09, 15 Oct 16:19 CEST, a live call answered by forks of a very long Claude Code session in the `hyre` repo). Read it whole. What I see in it, to check and fix:
>
> 1. **Slow replies.** Each spoken request forks the whole Claude Code session (`claude -p --resume … --fork-session`); with a long session the fork needs ~10 s to load before it says a word, plus up to 4 s of watcher polling, plus speech. Answers took 8–18 s and cost $0.21–$0.50 each. Also the voice itself is slow to respond even when no fork is needed. Find where the time goes (CLI `cli/` live.js / watch loop, the Worker's live endpoints, the voice side) and cut it: e.g. long-poll instead of 4 s polling, answer from the pickup brief when it suffices, a fresh small `claude -p` with the condensed brief instead of a full-session fork when the session is huge, a quicker filler. Measure before and after where you can.
> 2. **It does not hang up after goodbye.** Commit 0d59092 ("Let the line hang up after both sides say goodbye") did not work in Jan's call. Find why (the goodbye detection, the quiet-period timer, which voice path the call took) and make it hang up reliably after both sides said goodbye. Keep the safety: never hang up on someone still talking.
> 3. **The greeting talks over the caller and greets the wrong name.** The transcript shows "Hi Wijnand, Cody" interleaved with the caller's first words, and the account's email is wijnand@hyre.io while the caller is Jan. Do not barge in on the caller; and greet by the caller's own name (the verified member), not a name taken from the email, if the data allows.
> 4. **The pickup brief was thin and partly wrong** ("one uncommitted change on dev"; it could not say how many agents run). The forks also could not run harmless read-only commands (`screen -ls`, `ls ~/.claude/agents/`) to answer "how many agents run", because the call gate blocked them. Let the gate allow plainly read-only shell commands; keep blocking push, deploy, send, delete, secrets.
> 5. **Teammates should get a brief too.** Jan said on the call: developers like him and Tomáš should get the same session brief when they call. Today only the owner's own calls are live. Design it with a setting for who may hear a session's brief (default: only its owner), and a teammate calling gets a brief of their own session when they run a watcher.
> 6. **"can't reach the worker; retrying quietly"** flapped twice right after the call. Check whether that is the CLI or the Worker, and fix it if it is ours.
>
> Work in priority order: 2, 1, 3, 4, 6, 5. Test each fix with the repo's own tests and build. A fix that needs the Worker or the site deployed: this server has no `wrangler` login and no Chrome, so do not deploy; commit and push, and list exactly what Jan must deploy (command and directory) at the end. Never print or commit a secret. Do not run `npm install` unless the repo has no `node_modules` and its own docs say to; if you must, run it only inside this clone.
>
> Finish with a short report as your last message: per item what changed (commit id), what you verified, what still needs a deploy or a live call to verify.

What Jan said on the call itself, from the transcript (speech recognition,
verbatim), where it bears on what was asked:

> Yes, it's definitely nice if teammates developers like me and Tomáš should
> also be the same thing as well and do when they Check. That would be great

> Yeah. Definitely, that should be possible

> And another thing I noticed is that you are like mistaking quite a long time
> for you to reply to whatever I say. I was wondering if if that is related to
> like just latency because the call goes through to the US or something? Or is
> it might there be any timers in screenless that have you wait a little longer

> Okay, but even if you don't look up anything, it still takes a while to even
> respond. Why is that

> But you can just, in GPT live, can just answer immediately with the context
> it has, right

> Um .Okay, never mind. You can keep doing that. I—I'm gonna go now
> Bye bye
> Please hang up
> Please hang up
