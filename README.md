# screenless

**A phone line for your team and its coding agents.** Walk away from the
keyboard and your agents don't stall: when one hits a decision only a person can
make, it phones you — or anyone on your team — takes your answer out loud, and
keeps working. Unblocked from anywhere. No screen.

![An agent hits a decision, calls you, and continues from your answer](demo.gif)

## What it is

screenless is a CLI and a small Cloudflare Worker that give a team a shared
phone number wired to the terminals it runs. The number goes both ways:

- **Ring in** — a teammate calls the line and speaks a request, a decision, an
  idea. It is transcribed and routed to whoever is running `screenless watch`:
  the caller's own terminal first, any teammate's otherwise, a queue that holds
  up to a week when nobody is. Their agent picks it up and acts.
- **Ring out** — `screenless call "…" --to alex@team.com`, or `--all`. Dial one
  teammate or the whole team and each conversation returns as a transcript. It
  only ever reaches verified numbers on your own team.
- **Watch** — `screenless watch` in a terminal is where the calls land. Arm it
  in your coding agent with **`/screenless`** and leave it open.

The voice on the phone has no tools and no credentials. It collects decisions
and hangs up; a terminal on your own machine — with the MCPs, the logged-in
browser and the Claude subscription you already gave it — is what merges,
comments, and closes. A teammate's request arrives marked as untrusted, weighed
before it runs with your access. **Nothing leaves your machines but a question
and an answer.**

## Skills

A *skill* is a prompt that points the line at a job. The CLI is the tooling; two
skills ship as worked examples, and you build the rest.

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
`screenless setup` — phone verification by SMS, no card. Then, in your agent,
**`/screenless`** arms the watcher so the team's calls land in your terminal.
Every team starts with **$10 of free credit**; after that calls are
pay-as-you-go at **30¢/minute** from the team's shared balance. Node 20+
required, never installed for you.

The whole integration story is that it runs on your machine:

- **Your MCP servers are the integrations.** Linear, GitHub, Slack, your ATS —
  whatever you already connected, it can already read. No OAuth app to install.
- **Your browser is the screenshot tool**, already logged in.
- **Your Claude subscription is the LLM.** Nothing is metered per token by us.
- **Nothing leaves your machine** but the call and the email.

Manage your team, roles and billing at
[screenless.sh/team](https://screenless.sh/team).

## Status

The **line is real and proven**: calling out, ringing in, calling teammates,
transcription, routing to a watching terminal, pay-as-you-go billing, teams and
invites — all of it works on real phones today, in production at screenless.sh,
verified end to end with live calls.

What is **still early is the intelligence in the skills** — the morning
briefing's hard part, reading a queue of pull requests and picking out the few
that genuinely need a person, is being built in the open. The line and
`call-when-afk` work now; the nightly loop and weekly paper render and deliver
but have not run unattended against a real repo for a full week.

## Self-hosting

The hosted service at [screenless.sh](https://screenless.sh) is the default and
needs none of this. To run your own Worker and CLI — Telnyx, Cloudflare, Stripe,
configuration, the full command reference, and the notes found the hard way —
see **[SELFHOST.md](SELFHOST.md)**.

## License

MIT — see [LICENSE](LICENSE).
