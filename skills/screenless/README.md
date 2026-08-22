# loop — the armed session

One skill, armed once in a Claude Code session, producing both surfaces from a
single reading of the repo — the paper, and the morning call's brief — and
applying what the call decided afterwards.

- [`SKILL.md`](SKILL.md) — what the loop actually does, in four modes:
  `start`, `tick`, `status`, `stop`. This is the thing Claude reads.
- [`APPLY.md`](APPLY.md) — the return leg: transcript plus manifest in,
  comments, labels and merges out.
- `screenless wait` — the gate, in the CLI (`cli/src/index.ts`). Pure node,
  no model: probes every minute and exits when there is work.

## Why it runs inside a session

The first version scheduled two launchd jobs that ran `claude -p` at 03:00 and
every five minutes. They fired every night for four nights and shipped nothing,
for three independent reasons, any one of which was enough: a process launchd
starts cannot read a repo under `~/Desktop` (macOS TCC, surfacing as
`EPERM`); `claude -p --permission-mode acceptEdits` denies every Bash call and
every write outside the repo when there is nobody to approve; and the press
toolkit was never installed anywhere the skill could find it.

A session the user already has open has none of those problems — it inherits
the terminal's file access, its permission mode, its MCPs, its browser and its
subscription. So the loop lives there, the way the orchestrator does: arm it
with `/screenless start` and leave the window open. The one property that
costs is that nothing happens with the session closed; in practice, nothing
happened with the scheduler either.

## How it waits

```
/screenless start
```

runs one tick, then arms `screenless wait` as a background command. The waiter
probes every 60 s in pure shell — no model, no tokens — and prints a line only
when its reason changes, so a quiet night is a handful of `NO - …` lines. It
exits the moment there is something to do, and the harness re-invokes the model
on that exit: **the waiter's exit is the next tick.** Two reasons to wake:

| Line | Means |
|---|---|
| `NIGHTLY <repo>` | It is past 03:00 machine time and no edition is stamped for today. One line per registered repo. |
| `APPLY <callId>` | A call finished and nobody has applied its decisions. |

A `/loop 1h /screenless tick` heartbeat runs alongside, so a waiter that dies
costs at most an hour rather than the night. The waiter also gives up after 40
minutes and asks to be re-armed — never wait forever.

## When it runs

At **03:00**, or on the first probe after it. The waiter's `sleep` resumes with
the lid, so a laptop shut overnight wakes straight into `NIGHTLY` — the
"first thing when the laptop opens" behaviour, with no daemon and no catch-up
logic anywhere.

That makes idempotence load-bearing. The waiter stamps `~/.screenless/last-run`
with today's date *when it hands `NIGHTLY` over*, before the build, so a crash
mid-run is a missed night and not four papers and four phone calls over
breakfast. `SCREENLESS_FORCE=1 screenless wait --once` ignores the stamp.

The catch-up case also changes what the run does. Parking a brief for 08:00 at
09:40 would mean either a call tomorrow or a phone ringing seconds after the
laptop opens. Instead the skill parks it **held**: nothing dials, and the user
rings the number when they are ready.

## What lives where

| | Where | Why |
|---|---|---|
| The skill, and `press/` beside it | `~/.claude/skills/screenless/` | Same for every repo. Installed by `curl \| bash`, replaced on reinstall. |
| A project's settings | `<repo>/.screenless.json` | Belongs with the code it describes. Written by `screenless init`. |
| Which repos get a paper | `~/.screenless/projects.json` | A property of the machine, not of any checkout. |
| Tonight's stamp, last applied call | `~/.screenless/last-run`, `state.json` | The two facts the gate needs. |

## Install

The skill and the toolkit arrive with the CLI:

```bash
curl -fsSL https://screenless.sh/install | bash
screenless init            # in each repo you want a paper about
```

Then, in Claude Code, in any of those repos:

```
/screenless start
```

`/screenless status` says what the next probe would do; `/screenless stop`
ends it. The installer also removes the launchd jobs an earlier version left
behind.

## Delivery

Both surfaces are parked with the Worker and released on the user's schedule,
because the machine that builds them at 03:00 is usually shut by the time
either should arrive:

- the paper with `screenless mail <pdf> --at`, sent by Resend from
  `MAIL_FROM`;
- the brief with `screenless call "<brief>" --at`, dialled by Telnyx.

Delivery is the Worker's job rather than a messaging MCP's because a reader
cannot be assumed to have Slack or a mail MCP connected, and a second surface
that only works for people with the right integration is a second product. It
is also what makes the call happen even if the session is closed by then.

## Publishing a change to these files

`SKILL.md`, `APPLY.md` and `press/` are downloaded by the installer over HTTP,
so a change here is not live until the site is rebuilt:

```bash
cd site && npm run deploy
```
