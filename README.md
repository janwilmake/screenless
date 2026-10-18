# screenless

**Call your Claude Code session.** From a walk, the car, wherever: ring the
line or call it on WhatsApp, ask where things stand, tell it what to do, and it
does the work while you are still on the call. On your own machine, with the
access your session already has.

Hear a demo call at **[screenless.sh](https://screenless.sh)**.

## How it works

1. **Install** — `curl -fsSL https://screenless.sh/install | bash` installs the
   CLI and verifies your phone number.
2. **Arm a session** — type **`/screenless`** in Claude Code. That session now
   answers the line.
3. **Call** — ring the number, or call it on WhatsApp. A voice talks with you;
   each thing you ask runs in a fork of your session on your machine, and the
   answer is spoken back during the call. Read, edit, test, commit, push,
   deploy, post to Slack: whatever the session can do at the keyboard. It tells
   you how longer work is going while you wait.

**Only you get through.** The line never answers a phone call on its caller id,
which is easy to spoof: it hangs up and rings your verified number straight
back, so only your phone can pick up. A WhatsApp call is tied to your account
and is answered at once.

**The voice holds no keys.** It has no tools and no credentials; it talks, and
your session acts. Your code, your MCPs, your logged-in browser and your Claude
subscription stay on your machine. What passes through the service is the call
itself: its audio, the transcript, and the short answers your session sends
back to be spoken.

## Your team

Everyone on a team shares the one number and reaches their own session.
Around that:

- **Teammates can listen in** — share your session's brief
  (`screenless watch --brief-for team`) and a teammate who rings hears where it
  stands. What they ask is noted for after the call; it never runs on your
  machine while they are on the line.
- **Say who may do what** — a `.agents/permissions.md` in the repo gives each
  teammate a mode: `listen` (heard, noted for later), `read` (their requests
  look things up and answer during the call) or `full` (they may have your
  session send, merge or ship), with your own rules for each mode in plain
  words. Teammates it names above `listen` get live calls into your session.
  The same file can drive other agent tools, so one list of people serves
  the phone line and, say, a Slack bot. See the `/screenless` skill for the
  format.
- **Nobody watching? It waits** — call while no session is armed and the
  request is transcribed and queued for the next teammate's terminal running
  `screenless watch`, for up to a week.
- **Ring out** — `screenless call "…" --to alex@team.com`, or `--all`, phones
  one teammate or the whole team and returns each conversation as a
  transcript. It only ever reaches verified numbers on your own team.

## Skills

A *skill* is a prompt that points the line at a job. **screenless** itself is
the skill that arms a session; two more ship as worked examples of agents
calling *you*, and you build the rest.

- **call-when-afk** — tell your agent you're stepping out and it stops pausing
  on questions. It phones you each one and continues the moment you answer.
- **morning-pr-review** *(optional)* — the nightly loop. At 03:00 it reads your
  repo's pull requests and tickets, calls each person about the few decisions
  that are theirs, and hands the transcript to your agent, which does the work.
  On Saturdays it also mails a weekly team paper: who shipped what, and the week
  ahead.

Install the skills into any coding agent — Claude Code, Cursor, Codex, and the
rest — with one command via [skills.sh](https://skills.sh):

```bash
npx skills add janwilmake/screenless
```

## Install

```bash
curl -fsSL https://screenless.sh/install | bash
```

One command: the CLI lands in `~/.screenless`, gets a launcher on your PATH,
installs the skills into every coding agent it finds, and goes into
`screenless setup` — phone verification by SMS, no card. Then, in Claude Code,
**`/screenless`** arms the session. Every team starts with **$10 of free
credit**; after that calls are pay-as-you-go at **30¢/minute** from the team's
shared balance. Node 20+ required, never installed for you.

Manage your team, roles and billing at
[screenless.sh/team](https://screenless.sh/team).

## Status

**Calling your session works on real phones today**, in production at
screenless.sh: phone calls with the ring-back, WhatsApp calls, live answers
from a fork of the session, progress updates, barge-in, wideband audio.
Ringing in to the queue, calling teammates, teams, invites and pay-as-you-go
billing work too.

What is **still early is the intelligence in the skills** — the morning
briefing's hard part, reading a queue of pull requests and picking out the few
that genuinely need a person, is being built in the open. The nightly loop and
weekly paper render and deliver but have not run unattended against a real
repo for a full week.

## Self-hosting

The hosted service at [screenless.sh](https://screenless.sh) is the default and
needs none of this. To run your own Worker and CLI — Telnyx, Cloudflare, Stripe,
configuration, the full command reference, and the notes found the hard way —
see **[SELFHOST.md](SELFHOST.md)**.

## License

MIT — see [LICENSE](LICENSE).
