# Give your session a seat on the team

A product idea, written 18 October 2026 for later. Not being built now.
Name: **Remo** (Jan, 18 October 2026), a company-level umbrella being
Wilmake. It would combine watchloop and screenless. Still to check: the
domain, and the trademark in software, where remo.co (a virtual-events
platform) already uses it.

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

| | **Remo** | **Kylon** | **Claude Tag** | **Claude Remote Control / Channels** |
|---|---|---|---|---|
| Where people talk to it | Their own Slack, email, calendar, Meet; WhatsApp and phone as add-ons | A new Kylon workspace (rooms, threads, records, files) | Slack | The Claude app, browser; Telegram and Discord (Channels) |
| Who can reach it | The whole team, per-person levels | The workspace's members | The Slack workspace | Only the developer |
| Where the agent runs | The developer's machine, live session | Each person's own machine, joined through the Kylon CLI | Anthropic's cloud, fresh sandbox per task | The developer's machine |
| Logged-in browser | Yes | Presumably, since it runs locally **[unverified]** | No | Yes (Remote Control with `--chrome`) |
| Its own identity (name, photo, mailbox) | Yes | No: agents appear as "Claude Code" or "Codex" | No: it's "@Claude" | No |
| New tool to adopt | No | Yes, the workspace | No, if Slack is used | The Claude app |
| Price | Not set; mostly free to run | Not published | Team/Enterprise plans plus usage | Included in Claude plans |

**The short version for Kylon:** Kylon asks a team to move its work into a
new place where agents are members. Remo leaves the team where it is and
gives the session a seat there.

## Pricing

Jan's choice (18 October 2026): **per active user**. It replaced an earlier
$299 a month per identity, because per user grows with the team, is familiar
to buyers (Slack and Hyre both charge per user), and bundles naturally with
Hyre.

| Plan | Price | What's in it |
|---|---|---|
| **Per active user** | **$29 / month per active user**, minimum 5 ($145) | All identities (Cody, Mark, Rex…); Slack, email, calendar and Meet; unlimited WhatsApp; ~30 call minutes per active user, pooled across the team; per-person levels; change log |
| Extra call minutes | 40¢ a minute | Billed with the next invoice |
| **Design partners** | 50% off for 3 months | In return for weekly feedback; full price after that |

**Only active users count.** Everyone on the team gets access; you pay only
for colleagues who actually asked an identity something that month (Slack's
"fair billing" idea). Giving access costs nothing, so nobody holds back
seats and colleagues don't go back to asking the developer. Revenue still
grows with real use. "Active" is counted from the logs: who asked what, on
which channel.

**All identities included.** More of them (Cody, Mark, Rex) make the product
more useful, not more expensive.

**Examples:**
- **A 10-person team with 8 active users:** $232 a month.
- **A 20-recruiter agency with 18 active:** $522.
- **A team of 3:** the $145 minimum.
- **For Hyre:** an add-on to its existing per-user price.

**What the customer's stack costs:** a server (~$150/month) and Claude Code
(Max, $200/month), plus the per-user price. Together that stays less than an
hour a day of a developer's time (~$1,500–2,500 a month at developer rates),
far less than a junior hire ($3–5k a month), and in line with "AI employee"
products ($500–2,000+ a month).

**Our costs:** call minutes (~15–20¢ each; the ~30 pooled minutes per active
user cost us ~$5–6) and WhatsApp (fractions of a cent). Slack, email and
calendar cost us next to nothing. So the margin stays high.

**The goal:** $10k MRR is **~345 active users**: for example 40 teams
averaging 9 active users, or fewer, larger recruitment agencies.

**No managed seat** (Jan, 18 October 2026: too risky). We don't run
servers or Claude subscriptions for customers. The seat always runs on the
customer's own machine or server, with their own Claude account; the
always-on guide (screenless.sh/always-on) shows how. One thing to tell
customers anyway: Claude Max is an individual plan, and answering a whole
team through one person's subscription may conflict with Anthropic's terms.
Claude Team or Enterprise seats, or the API, are the clean options. That is
their account and their call.

**If $29 meets resistance:** don't lower it before anyone has said no. If
needed, test $19 against $29 per active user with the design partners.

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
3. **A payment test at the end of week 2.** "Keep it for $29 per active user
   a month (50% off for the first three months), phone and WhatsApp
   included", with a Stripe link. The yes rate is the proof.

**Verdict after 4–6 weeks:**
- **Proof:** at least 3 of 5 design partners have non-developers asking every
  week, set up in under 30 minutes, and 2 or more pay.
- **Disproof:** colleagues try it once and go back to asking the developer;
  or the setup keeps stalling on admin approvals; or nobody pays once it
  stops being free.

**What to measure:** messages and requests per channel and per asker,
answers sent, time to answer, setup steps completed (the setup prompt can
report its own progress), and payments.

## Recruitment: the first market?

Two directions, both through Hyre.

**The seat uses Hyre.** Hyre's MCP already has the recruiting toolset: ATS
and CRM read and write, candidate–vacancy matching, sourcing, LinkedIn
messages, outreach drafts, tasks, calendar, and routines such as
*Start je dag* and *Sluit je dag*. With that connected, the seat becomes a
recruiting colleague:
- **Slack or WhatsApp:** "Who applied to the backend vacancy today?", "Find
  five Java developers near Utrecht for client X".
- **A voice note after a client meeting:** the seat logs it in the ATS,
  creates the tasks and drafts the follow-up email for the recruiter to
  approve.
- **Its calendar:** "Plan an intro with Sanne on Thursday". The seat finds a
  slot and sends the invite from its own address.
- **A morning call for recruiters on the road:** *Start je dag* by phone at
  8:00 (today's priorities, candidates to call back, interviews). It is the
  morning call screenless started with, in a market that drives a lot.

**Recruitment teams as the market.** They match the seat's strengths:
- **Logged-in web apps without good APIs:** LinkedIn Recruiter, ATSes, job
  boards. That is exactly what cloud bots can't reach.
- **WhatsApp and phone first, especially in the Netherlands.** There these
  are the main channels, not add-ons.
- **Non-technical:** they gain the most from "just ask a colleague".
- **A built-in audience:** Hyre's customers. "Your Hyre comes with a
  colleague you can WhatsApp."

**To solve first:**
- **Who runs the session?** A recruitment agency has no developer and no
  server, and there is no managed seat. Either Hyre (the company) runs the
  recruiting seat as part of the Hyre product, as Hyre's own agents already
  run, or the seat stays a product for teams with a developer, and
  recruitment is reached through Hyre itself. The choice shapes the
  business.
- **Compliance.** The EU AI Act classes AI used to recruit, screen or
  evaluate candidates as high-risk, with real obligations, and candidate data
  falls under GDPR. Everything candidate-facing (messages, rankings,
  rejections) stays a draft a person approves: the seat prepares, the
  recruiter sends.

**Test it internally first:** **Rex**, the recruiter seat at Hyre, beside
**Cody** (code) and **Mark** (marketing), with the Hyre MCP and a logged-in
LinkedIn. Rex sounds like "recs", as in recruiter (Jan, 18 October 2026). Measure the
same things as for Cody: asks per recruiter per week, per channel, and what
it saved them.

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
  needs to be easy: a guide and the install prompt, not hosting by us.
- **Setup friction:** Google Workspace and Slack admin rights aren't always
  with the developer.

## Open questions

- **More agents:** does the seat work with Codex and the others from the
  start (see `research/agent-hosts.md`), or Claude first?

Sources: https://kylon.io/blog/codex-claude-code-agents-home,
https://kylon.io/blog/codex-kylon-workspace,
`research/x-buying-signals-2026-10-18.md`, `research/agent-hosts.md`.
