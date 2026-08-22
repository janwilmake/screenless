---
name: morning-pr-review
description: The optional nightly loop that turns a repo's overnight pull requests into a morning phone call — and, on Saturdays, a weekly team paper. Armed in a Claude Code session, it waits in pure shell until 03:00 (or the first wake after), reads the repo's tickets, PRs and code once, writes the call brief (three decisions, hardest first) and a decisions manifest, parks the call for the user's call time, and on Saturday builds and mails the edition. It does not place or apply the call itself — the screenless watcher does that. Modes - start, tick, status, stop. Use when the user says "start morning pr review", "arm the nightly loop", "build tonight's brief", or "build the weekly edition".
---

# morning-pr-review — the nightly loop

The optional half of screenless. The core product is the phone line (the
`screenless` watcher skill); this skill points the line at one job: **every
night at 03:00, read what your agents did and prepare a morning call about the
few decisions that need a person.** On Saturdays it also builds a weekly team
paper. It is separate and optional — arm it only in repos you want a morning
briefing about.

It **builds and parks**; it does not dial and does not apply. The Worker places
the parked call at your call time, and the `screenless` watcher — armed in a
session, yours or a teammate's — picks up the finished call and applies what you
decided, reading the decisions manifest this run writes.

The call answers *what do I need to decide today?* and is built every night.
The paper answers *what is my product becoming?* and is built **once a week, on
Saturday's run**, to land Saturday morning.

## Modes

| Argument      | Mode                                                        |
| ------------- | ---------------------------------------------------------- |
| none, `start` | **Arm the loop** — one tick now, then block until 03:00.  |
| `tick`        | **One tick** — probe once; if it's due, build tonight's run. |
| `status`      | Say what the next probe would do. Change nothing.          |
| `stop`        | Stop the waiter and the heartbeat. Change nothing else.    |

It lives *in this session* rather than a scheduler, on purpose: a launchd job
running `claude -p` had no Desktop access, no way to approve a tool call and no
MCPs — four nights, nothing shipped. Here the agent has the tracker, `gh`, the
browser and the subscription the reading needs. The price is that the session
stays open.

### Mode: start

1. Run **one tick** (below) so the user sees it do something real — usually
   `NO - …`, which is fine.
2. **Arm the waiter** — Bash tool, `run_in_background: true`,
   `dangerouslyDisableSandbox: true`:

   ```
   screenless wait
   ```

   It probes every 60 s in this process, no model, and prints one line when its
   reason changes. The harness re-invokes the model when the backgrounded
   command exits, so **the waiter's exit is the next tick**: when it wakes you,
   read what it printed and go to *Mode: tick, step 2*. It gives up after 40
   minutes and exits with `re-arm` — arm it again and say nothing else.
3. **Add the heartbeat**, because a waiter that dies takes the night with it:

   ```
   /loop 1h /morning-pr-review tick
   ```

4. Tell the user it is live: when tonight's run is due (03:00 machine time, or
   the first probe after if the lid was shut), and that `/morning-pr-review
   stop` ends it. If they also want to take incoming calls, point them at
   `/screenless` to arm the watcher beside this.

Do not detach the waiter with `nohup` or hide its output in a log.

### Mode: tick

1. Probe, outside the sandbox:

   ```
   screenless wait --once
   ```

   (`SCREENLESS_FORCE=1 screenless wait --once` runs tonight again even though
   it is stamped — for testing, or a night you want redone.)

2. Act on every line it printed:

   - `NO - <reason>` — say the reason in one line and stop.
   - `NIGHTLY <repo>` — run **one night** (below) for that repo, `cd` there
     first: the brief always, and the weekly edition on Saturday's run (or when
     one was missed — see *One night*). Several lines means several repos; do
     them one after another, and one failing must not cost the others their
     brief.

   (`WORK` lines are the watcher's, not this skill's — if you see one, the
   `screenless` skill handles it.)

3. If the waiter woke you, re-arm it (*start*, step 2) before finishing the
   turn. A tick that does not re-arm is the loop ending quietly.

### Mode: status

`screenless wait --peek` — same probe, never stamps — and `screenless settings
--json` for when the phone will ring. Report both. Spawn nothing, run nothing.

### Mode: stop

Stop the backgrounded `screenless wait` (TaskStop on its task) and end the
`/loop` heartbeat. Say tonight's run will not happen until it is armed again.
Nothing parked with the Worker is touched: a brief already parked still rings,
a paper already mailed still lands. (This does not touch the `screenless`
watcher, if that is armed too.)

## Where the settings come from

Nothing project-specific lives in this file. Each project carries its own
`.screenless.json` at its root:

```json
{
  "repo": ".",
  "tracker": "linear",
  "trackerTeam": "Platform",
  "ticketPrefix": "PLAT",
  "appUrl": "http://localhost:3000",
  "outDir": "~/screenless/press",
  "deliverTo": "you@example.com",
  "windowDays": 7
}
```

Read it from the repo you are running against. If it is missing, say so and
stop — guessing a ticket prefix produces a paper about the wrong thing.
`screenless init` writes one.

Two settings are deliberately *not* in that file:

- **The call time and language** live in the Worker, set with
  `screenless settings`, because they belong to the person being called.
- **Which repos run at 03:00** lives in `~/.screenless/projects.json`, because
  the nightly job is a property of the machine, not of any one checkout.

## The split that matters

Deterministic facts come from scripts. Judgement comes from you. Do not blur
these — a model re-deriving line counts wastes tokens and gets them wrong, and a
script deciding what is interesting produces a paper nobody reads.

| Scripts decide                         | You decide                                    |
| -------------------------------------- | --------------------------------------------- |
| Composition, churn, staleness, PR ages | What the week's story is                      |
| Which files changed, and how much      | Which four to six things deserve a page        |
| Ticket status and assignee             | Which three things deserve a *decision*        |

## One night

The toolkit this section calls lives next to this file, at
`~/.claude/skills/morning-pr-review/press/` — write `press/…` below as that path.

**First decide whether tonight is an edition night.** The edition is weekly:
build it when the machine's local date is **Saturday**, or when the newest
edition PDF in `outDir` is more than seven days old (the catch-up for a Saturday
the laptop slept through). Every other night, do only the brief-sized share of
the reading — steps 1–4 scoped to what the call needs — then steps 5b, 5c and 7.

On an edition night, steps 1–4 are the shared pass over the whole week. Do them
once. Step 5 splits the result into the two surfaces; steps 6–7 deliver them.

### 1. Check the ground is readable

`git -C <repo> status`. A half-finished rebase produces nonsense churn numbers.
If the tree is dirty in a way that would skew the data, say so rather than
aborting.

### 2. Collect the deterministic facts

```bash
node ~/.claude/skills/morning-pr-review/press/bin/collect.mjs --repo <repo> --days <windowDays> > /tmp/press-facts.json
```

Composition, churn by area over both windows, commits per day, per-author
activity, staleness, open PRs with age and size, and the areas each PR touches.
If `pullRequests.available` is `false`, `gh` is not authenticated — say so in
the edition and on the call rather than shipping as though the night was quiet.

### 3. Pull the tickets

Use the tracker MCP named in the config. For `trackerTeam`:

- every ticket **In Progress** or **In Review**
- every ticket moved to **Done** inside the window
- on an edition night, also the top of **Todo / Backlog** — ten or so, in the
  tracker's own priority order, for the week-ahead page
- for each: identifier, title, status, assignee, and the description — the
  description is where the *intent* lives, and intent is what a diff cannot tell

Match tickets to PRs by `ticketPrefix` in the branch name, PR title, or body.
Record tickets with no PR and PRs with no ticket; both are findings.

### 4. Read enough code to be right

Do not summarise a diff you have not read. For the 4–6 items that will earn a
page or a decision:

- `gh pr diff <n>` for the actual change
- the files it touches, when the diff alone is ambiguous
- the docs describing the area it changes — if the change makes a document wrong,
  that is among the most valuable things either surface can carry

Read deeply for those few; not at all for the rest.

### 5. Split the one reading into two artefacts

Write both from the same notes, paper first — writing it forces you to decide
what the week's story was. **The paper** is one-way and complete-ish. **The
call** is interruptible and ruthless: three items, each a dossier understood
cold. Something can be interesting enough for a page and not important enough
for the call. Almost nothing is the reverse.

#### 5a. The edition (Saturday only)

The weekly team paper: what happened this week, who did it, and what is coming —
the state of the product, not one person's queue.

Author `edition.json` next to the output PDF. Read `press/example/edition.json`
first. Structure, in order:

1. **Masthead** — one headline naming the week's actual story, a standfirst, four
   stat tiles. The headline is a claim, not a label.
2. **A composition page** — treemap of what the product is made of.
3. **A movement page** — churn by area, plus the ticket status bar.
4. **The week, by person** — who shipped what. `collect.mjs` emits `authors`
   (commits, lines, areas each); pair each teammate with the merged PRs and
   tickets that were theirs, one caption each, not a commit-count contest. A
   member with nothing merged is left out, not called out.
5. **The deep dive** — one or two pages on how *one thing in the product works
   today*. See below; the part worth the most, and the part that takes real
   reading.
6. **One page per ticket in flight**, four to six, each with a plain-language
   caption, a structural figure, and a `decision` line where one exists.
7. **The week ahead** — open PRs by age and owner, and the top of the backlog
   in priority order. A `table` each; captions say what to expect, not what to do.
8. **An attention page** — PR ages, what is not moving, what is stale, which
   docs the week made wrong.

#### The deep dive

Pick **one** area the reader is working on or about to decide about, and explain
how it works *now* — not what changed. The test: someone away for a month could
make a call about that area after two pages. Real research, not a diff summary:
read the models, routes, jobs, the places that write and read. Follow one path
end to end; a surprise you find (two sources of truth, a table nothing reads, a
route with no auth) *is* the deep dive. Build it from figures:

- a `schema` figure of the entities and how they relate
- a `table` of the routes, events or jobs that touch them
- captions naming what to notice, one sentence on what it means

Say at the top why this area was chosen.

Writing rules:

- **Captions, not paragraphs.** Over ~40 words means it belongs on the call.
- **Every chart earns a caption saying what to notice.**
- **Never chart lines-changed or files-touched per PR** — a fact about the diff,
  not the product, and stale by morning. Chart what the change acts on — tables,
  routes, events, states. No structural figure worth drawing? Give it none.
- **Spot colour once per page at most.**
- **`decision` is only for taste-and-scope questions**, not correctness.

Render it:

```bash
node ~/.claude/skills/morning-pr-review/press/bin/render.mjs <edition.json> --out <outDir>/<date>.pdf
```

`--keep-html` prints the intermediate HTML. Over ~ten pages means it is trying
to be complete rather than useful; cut ticket pages before the deep dive.

Figures: `treemap`, `bar`, `status`, `age`, `spark`, `schema`, `table`. `schema`
takes `entities` (each with `fields`, optional `column` 0-2, `spot`) and
`relations` (`from`, `to`, `label`); `table` takes `columns` and `rows` (a row is
an array of cells or `{cells, spot}`). Both are in `press/lib/charts.mjs` — read
it before inventing a figure it cannot draw.

#### 5b. The call brief

The brief is the prompt the phone assistant is given. It is spoken, so write it
to be *said*, and it is the assistant's **only** source of truth on the call.

The first real call taught this: six decisions in a row lost the caller by the
second. Write for a person hearing it cold at breakfast, not for a list.

- **Three items. Never more.** The three that most need a human, hardest first.
  Everything else is in the paper, and the last line names what was left out.
- **Each item is a small dossier, not a question.** In order:
  1. *What it is*, in one breath, in the product's words.
  2. *How that part works today*, two or three sentences.
  3. *What the agent did and why* — the choice, the rejected alternative, the
     cost to undo. Quote the PR's own Decisions section; do not paraphrase away.
  4. *What else this touches* — other PRs, tickets, readers of the same table,
     a doc it makes wrong.
  5. *Numbers worth having ready* — spoken, not written: "about seventy-five
     thousand rows", never "74,571".
  6. *The one question*, with named options. Last, not first.
- **Anticipate** the three questions the caller will ask — who asked for this,
  what breaks if we wait, is it reversible — and answer them in the dossier. If
  you cannot, say so: "I do not know whether X; that is for your eyes."
- **Write it in the account's language** (`screenless settings --json` →
  `language`). Product names, prefixes and table names stay as they are.
- **Pace it by shape, not instruction** — the Worker already tells the assistant
  to give context, check, then ask. Give it context worth checking. No
  "first/second/third"; no lists.
- **Name anything you could not decide** in one sentence after the third item.
- Length: up to 12,000 characters; a good three-item brief is 5,000–8,000.

End with the wrap-up line: the assistant says the transcript goes to their
agent, and hangs up.

#### 5c. The decisions manifest

Write `<outDir>/<date>.decisions.json` alongside the brief — one entry per
decision, in the same order:

```json
[
  { "id": 1, "prs": [412, 418], "tickets": ["PLAT-501"],
    "repo": "/absolute/path/to/repo",
    "question": "land together today, or take their turn?",
    "options": ["expedite both", "normal queue"] }
]
```

The brief is *spoken*, so it carries no PR numbers — "the outreach proxy fix",
never "PR 418". That is right for the ear and useless for the return leg, which
has to know which PR a decision was about. The manifest puts the identifiers
back, and is what the `screenless` watcher's apply step reads when the call is
answered. Write it every time, even for one decision; one entry per item in the
brief.

### 6. Park the paper for Saturday morning

```bash
screenless settings --json          # callAt, and the machine's timezone
screenless mail <outDir>/<date>.pdf --team --at <that callAt, or a little before> \
  --subject "screenless · <repo> · week of <date>"
```

`--team` sends it to every member with a verified email — the edition is the
team's paper. Runs on the edition night only. On a late catch-up build, park it
for the next morning; the subject keeps the week it covers. The Worker holds it
and sends at the local time — it does **not** send at 03:00. If the send is
refused, say so and leave the PDF at its path.

### 7. Park the call

```bash
screenless settings --json          # read callAt and the machine's timezone
screenless call "<brief>" --at      # park for the configured call time
```

Bare `--at` uses the user's own call time. **If the call time has already passed
today** — a catch-up after the lid was shut — park it held instead, and say so:

```bash
screenless call "<brief>" --hold
```

A held brief is not dialled; it waits for the user to ring in. Confirm what was
parked, and when it will ring.

## When this runs

Once a night, when `screenless wait` says `NIGHTLY` — at **03:00** machine time,
or the first probe after. The brief is built every night; the edition only on
Saturday's run (or the first after a missed Saturday). Two properties matter:

- **If the machine is asleep at 03:00, the run happens when it next wakes** — the
  waiter's `sleep` resumes with the lid, and the catch-up branch in step 7 is
  why that works rather than being theoretical.
- **It runs at most once per day.** The waiter stamps `~/.screenless/last-run`
  the moment it hands `NIGHTLY` over — before the build — so a crash mid-run is a
  missed night, not four papers and four calls.

If a step fails, ship a shorter paper and a shorter call. A missing section is a
finding; a missing paper is a broken Saturday.

## What this deliberately does not do

- **It does not take incoming calls** — that is the `screenless` watcher.
- **It does not place or apply the call.** It builds and parks; the Worker
  dials, and the watcher applies. A bad night produces a bad paper and nothing
  worse.
- **It does not ask you anything** — every question belongs on the call.
- **It does not decide when to call** — that is the user's setting.
- **It does not try to be complete** — six good pages beat thirty accurate ones.
