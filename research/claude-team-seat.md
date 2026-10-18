# Give your session a seat on the team

A product idea, written 18 October 2026 for later. Not being built now.
Working name: **Team Seat**. It would combine watchloop and screenless under a
new name.

## The idea in one line

Your Claude Code session gets its own identity on the team: a name, a photo,
a Slack account, an email address and a calendar. Your colleagues work with
it in the tools they already use, while it runs on your machine with your
access, under rules you set per person.

## Why it is strong

- **It meets people where they already are.** DM "Cody" in Slack, cc
  cody@company.com, invite Cody to a meeting. Nobody installs anything or
  learns a new place. Kylon and Claude Tag both ask teams to come to them.
- **The brain is the live session.** It has the developer's context, their
  MCPs and their **logged-in browser**. Cloud bots (Claude Tag, Codex in
  Slack, Grok Bot, Devin) can't have that browser without asking for
  credentials. For teams whose work lives in web apps without APIs (an ATS,
  LinkedIn, admin panels, vendor portals), that is the deciding difference.
  It is why Hyre doesn't use Claude Tag.
- **Most of it is nearly free to run.** The work runs on the developer's own
  Claude subscription. Slack, email, calendar and Meet cost us next to
  nothing; the seats are paid by the customer to Slack and Google. Only phone
  minutes and WhatsApp cost us real money, so those are the natural paid
  add-ons.
- **The demand is visible.** On X (October 2026), "Claude Code is built for
  one person", "multiplayer" and "trapped on a laptop" are live themes. One
  developer with 41k followers asked for a Claude Tag that talks to his *local*
  Claude, plug-and-play (`research/x-buying-signals-2026-10-18.md`).

## What it is made of

| Part | What it is | Exists today in |
|---|---|---|
| **Identity** | A Slack member and a Google Workspace user (mail, calendar, Meet), with a name and photo of the team's choosing | watchloop at Hyre (Slack); the rest is new |
| **Brain** | The developer's live Claude Code session; each request runs in a fork, each conversation keeps its own fork | screenless (calls, WhatsApp) |
| **Channels** | Slack DMs and mentions, email, calendar invites, Meet, and as add-ons WhatsApp and phone | Slack: watchloop. WhatsApp and phone: screenless. Email, calendar and Meet: new |
| **Rules** | Per-person levels on a team page, plus a people-free `.agents/permissions.md` in each repo | screenless (sessions 16–17) |
| **Proof of who asks** | The identity of whoever is in Slack or Google; phone ring-back; WhatsApp accounts | screenless |
| **Always on** | A server or an awake machine | screenless.sh/always-on |
| **Setup** | One prompt: the agent installs, creates the accounts by driving the admin pages in the developer's logged-in browser, and connects them. The person does only passwords, 2FA, consent screens and seat payments | screenless's install prompt (`llms.txt`) |
| **Overnight work** | Tickets in, reviewed pull requests out | watchloop |

## What would merge

- **From watchloop:** the Slack identity loop, the overnight ticket-to-PR
  worker (as a skill the seat can run), and the shared permissions file.
- **From screenless:** the hosted parts (team page, levels, verification,
  billing), the phone line and WhatsApp, forks and the gate, and install by
  prompt.

The product page sells the **seat**. The overnight loop, phone and WhatsApp
are things the seat can do.

## Comparison

| | **Team Seat** | **Kylon** | **Claude Tag** | **Claude Remote Control / Channels** |
|---|---|---|---|---|
| Where people talk to it | Their own Slack, email, calendar, Meet; WhatsApp and phone as add-ons | A new Kylon workspace (rooms, threads, records, files) | Slack | The Claude app, browser; Telegram and Discord (Channels) |
| Who can reach it | The whole team, per-person levels | The workspace's members | The Slack workspace | Only the developer |
| Where the agent runs | The developer's machine, live session | Each person's own machine, joined through the Kylon CLI | Anthropic's cloud, fresh sandbox per task | The developer's machine |
| Logged-in browser | Yes | Presumably, since it runs locally **[unverified]** | No | Yes (Remote Control with `--chrome`) |
| Its own identity (name, photo, mailbox) | Yes | No: agents appear as "Claude Code" or "Codex" | No: it's "@Claude" | No |
| New tool to adopt | No | Yes, the workspace | No, if Slack is used | The Claude app |
| Price | Not set; mostly free to run | Not published | Team/Enterprise plans plus usage | Included in Claude plans |

**The short version for Kylon:** Kylon asks a team to move its work into a
new place where agents are members. Team Seat leaves the team where it is and
gives the session a seat there.

## How to prove it

**What has to be true:**
1. **Colleagues use the seat weekly,** not just the developer, and in the
   tools they already have.
2. **A team gets set up in under 30 minutes,** with their agent doing the
   work and a person approving four or five screens.
3. **Teams pay** for the parts that cost something or that only a team
   needs: phone and WhatsApp, levels, the change log, always-on hosting.

**Experiments, in order:**
1. **Hyre (2 weeks), already possible.** Cody exists in Slack through
   watchloop; add an email address. Count per person per week: Slack DMs and
   mentions to Cody, emails, WhatsApp messages, calls. Ask non-developers what
   they asked it and whether it saved them waiting.
2. **Five design partners.** Start with the X candidates (@jasonzhou1993,
   @gonzalo__nunez, @Mohitsolves, @codewithdavid, @Sebasti54919704), then
   Jan's network. Set up the seat with them on a call, timing each step and
   noting where a person had to step in. Measure the time to the first
   colleague's answer, and weekly askers in weeks 1 and 2.
3. **A payment test at the end of week 2.** "Keep the seat for $X a month,
   phone and WhatsApp included", with a Stripe link. The yes rate is the
   proof.

**Verdict after 4–6 weeks:**
- **Proof:** at least 3 of 5 design partners have non-developers asking every
  week, set up in under 30 minutes, and 2 or more pay.
- **Disproof:** colleagues try it once and go back to asking the developer;
  or the setup keeps stalling on admin approvals; or nobody pays once it
  stops being free.

**What to measure:** messages and requests per channel and per asker,
answers sent, time to answer, setup steps completed (the setup prompt can
report its own progress), and payments.

## Risks

- **The platforms:** Anthropic (`claude self-hosted-runner`, Claude Tag going
  local), OpenAI and Microsoft are moving towards agent identities and team
  access. The local session plus logged-in browser plus existing tools is
  narrower ground than it looks.
- **Platform rules:** whether Slack's and Google's terms, and each customer's
  admins, accept a regular account driven by automation. Check this before
  marketing it.
- **Security:** an identity with mail and calendar is more sensitive than a
  phone line. The levels, the change log and "never send secrets" carry more
  weight.
- **Always on:** a laptop that sleeps breaks the promise. The server path
  needs to be easy, or perhaps offered.
- **Setup friction:** Google Workspace and Slack admin rights aren't always
  with the developer.

## Open questions

- **Price:** charge per seat (for example $29–79 a month) with phone and
  WhatsApp included, or make the seat free and charge for the add-ons?
- **The name.** Not checked for availability.
- **More agents:** does the seat work with Codex and the others from the
  start (see `research/agent-hosts.md`), or Claude first?

Sources: https://kylon.io/blog/codex-claude-code-agents-home,
https://kylon.io/blog/codex-kylon-workspace,
`research/x-buying-signals-2026-10-18.md`, `research/agent-hosts.md`.
