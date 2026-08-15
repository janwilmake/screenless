# loop — the nightly run

One skill, run once a night, producing both surfaces from a single reading of
the repo: the paper, and the morning call's brief.

- [`SKILL.md`](SKILL.md) — what the run actually does. This is the thing Claude
  reads.
- [`nightly.sh`](nightly.sh) — the runner. Idempotent per day, and refuses to
  start if the CLI is not set up.
- [`com.screenless.nightly.plist`](com.screenless.nightly.plist) — launchd job.

## Why one skill and not two

The paper and the call are built from the same reading — the same tickets, the
same diffs, the same judgement about what last night was about. Splitting them
means paying for that reading twice, and lets the two disagree: a paper whose
headline says one thing while the call asks about another is worse than either
alone.

They differ in what they keep. The paper is one-way and near-complete. The call
carries only what needs a human decision, hardest first, because the caller may
hang up at the fourth question. Something can earn a page and not earn a
question. Almost nothing is the reverse.

## When it runs

At **03:00**, via launchd's `StartCalendarInterval`, which has the one property
this needs: a calendar job missed because the machine was asleep or off runs as
soon as the machine comes back. So the rule is *03:00 if the laptop is on,
otherwise first thing when its owner opens it* — with no polling and no daemon.

That makes the runner's idempotence load-bearing rather than tidy. A lid opened
four times before breakfast fires the job four times; `nightly.sh` stamps
`~/.screenless/last-run` with today's date and exits early on the rest.

The catch-up case also changes what the run does. Parking a brief for 08:00 at
09:40 would mean either a call tomorrow or a phone ringing seconds after the
laptop opens. Instead the skill parks it **held**: nothing dials, and the user
rings the number when they are ready.

## What lives where

| | Where | Why |
|---|---|---|
| The skill | `~/.claude/skills/screenless/SKILL.md` | Same for every repo. Installed by `curl \| bash`, replaced on reinstall. |
| A project's settings | `<repo>/.screenless.json` | Belongs with the code it describes. Written by `screenless init`. |
| Which repos run at 03:00 | `~/.screenless/projects.json` | A property of the machine, not of any checkout. |

The split is the point. Putting the settings in the skill meant one global file
that only ever worked for one repo; putting the skill in the repo meant it could
not be installed in one command, and launchd had nowhere to look.

## Install

The skill arrives with the CLI:

```bash
curl -fsSL https://screenless.sh/install | bash
screenless init            # in each repo you want a paper about
```

Then the nightly job:

```bash
cp loop/com.screenless.nightly.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.screenless.nightly.plist
```

Edit the plist first if the repo is not at `~/Desktop/oss/screenless` — both the
script path and `PATH` are absolute, because a launchd job does not inherit a
login shell's environment.

Check it:

```bash
launchctl list | grep screenless
SCREENLESS_FORCE=1 loop/nightly.sh     # run now, ignoring today's stamp
tail -f ~/.screenless/logs/$(date +%F).log
```

Uninstall:

```bash
launchctl unload ~/Library/LaunchAgents/com.screenless.nightly.plist
```

## Delivery

Both surfaces are parked with the Worker and released on the user's schedule,
because the machine that builds them at 03:00 is usually shut by the time
either should arrive:

- the paper with `screenless mail <pdf> --at`, sent by Resend from
  `MAIL_FROM`;
- the brief with `screenless call "<brief>" --at`, dialled by Telnyx.

Delivery is the Worker's job rather than a messaging MCP's because a reader
cannot be assumed to have Slack or a mail MCP connected, and a second surface
that only works for people with the right integration is a second product.

## Linux and elsewhere

`nightly.sh` is portable; only the launchd job is macOS. A systemd timer with
`Persistent=true` has the same catch-up-on-wake semantics:

```ini
[Timer]
OnCalendar=03:00
Persistent=true
```
