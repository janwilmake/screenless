---
name: screenless
description: The nightly loop. Reads a repo's tickets, pull requests and code once, then produces both of screenless's surfaces from that one pass — the printable paper, mailed to land at wake-up, and the morning call brief, dialled at the user's call time. Both are parked with the Worker and released on the user's schedule. Runs unattended at 03:00, or catches up first thing when the laptop opens. Use when the user says "run the nightly loop", "build tonight's edition", "prepare my morning call", or "start screenless".
---

# screenless — the nightly loop

One run, one context, two surfaces.

The paper answers *what is my product becoming?* The call answers *what do I
need to decide today?* They are built together because they are built from the
same reading: the same tickets, the same diffs, the same judgement about what
mattered last night. Building them separately means paying for that reading
twice and — worse — letting the two disagree about what the week was about.

## Where the settings come from

Nothing project-specific lives in this file. This skill is installed once, at
`~/.claude/skills/screenless/`, and is the same for every repo it is pointed at.

Each project carries its own `.screenless.json` at its root:

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
  `screenless settings`, because they belong to the person being called rather
  than to a repo. Read them back at run time with `screenless settings --json`.
- **Which repos run at 03:00** lives in `~/.screenless/projects.json`, because
  the nightly job is a property of the machine, not of any one checkout.

## The split that matters

Deterministic facts come from scripts. Judgement comes from you. Do not blur
these — a model re-deriving line counts wastes tokens and gets them wrong, and a
script deciding what is interesting produces a paper nobody reads and a call
nobody answers twice.

| Scripts decide                         | You decide                                    |
| -------------------------------------- | --------------------------------------------- |
| Composition, churn, staleness, PR ages | What the week's story is                      |
| Which files changed, and how much      | Which four to six things deserve a page        |
| Ticket status and assignee             | Which three to six things deserve a *decision* |

## Running one night

Steps 1–4 are the shared pass. Do them once. Step 5 splits the result into the
two surfaces; steps 6–7 deliver them.

### 1. Check the ground is readable

`git -C <repo> status`. A half-finished rebase produces nonsense churn numbers. If
the tree is dirty in a way that would skew the data, say so in the edition
rather than aborting.

### 2. Collect the deterministic facts

```bash
node press/bin/collect.mjs --repo <repo> --days <windowDays> > /tmp/press-facts.json
```

Composition, churn by area over both windows, commits per day, staleness, open
PRs with age and size, and the areas each PR touches. If
`pullRequests.available` is `false`, `gh` is not authenticated — say so in the
edition and on the call rather than silently shipping as though the night was
quiet.

### 3. Pull the tickets

Use the tracker MCP named in the config. For `trackerTeam`:

- every ticket **In Progress** or **In Review**
- every ticket moved to **Done** inside the window
- for each: identifier, title, status, assignee, and the description — the
  description is where the *intent* lives, and intent is what a diff cannot
  tell you

Match tickets to pull requests by `ticketPrefix` in the branch name, PR title,
or PR body. Record tickets with no PR and PRs with no ticket; both are findings.

### 4. Read enough code to be right

Do not summarise a diff you have not read. For the 4–6 items that will earn a
page or a decision:

- `gh pr diff <n>` for the actual change
- the files it touches, when the diff alone is ambiguous
- the docs describing the area it changes — if the change makes a document
  wrong, that is among the most valuable things either surface can carry

Read deeply for those few; not at all for the rest.

### 5. Split the one reading into two artefacts

Now write both, from the same notes, in this order — the paper first, because
writing it is what forces you to decide what the week's story actually was.

**The paper** is one-way and complete-ish. **The call** is interruptible and
ruthless: it carries only what genuinely needs a human decision. Something can
be interesting enough for a page and not important enough for the call. Almost
nothing is the reverse.

#### 5a. The edition

Author `edition.json` next to the output PDF. Read `press/example/edition.json`
before writing your first one. Structure, in order:

1. **Masthead** — one headline naming the week's actual story, a standfirst of
   one or two sentences, four stat tiles. The headline is a claim, not a label:
   "Matching moved to the centre of the product" beats "Weekly summary".
2. **A composition page** — treemap of what the product is made of.
3. **A movement page** — churn by area, plus the ticket status bar.
4. **The deep dive** — one or two pages explaining how *one thing in the
   product actually works today*. See below; this is the part of the paper
   worth the most and the part that takes real reading.
5. **One page per ticket in flight**, four to six. Each gets a plain-language
   caption, a figure that shows something structural about what the change
   touches, and — where one exists — the `decision` line naming what is needed
   from the reader.
6. **An attention page** — PR ages, what is not moving, what is stale, which
   docs the week made wrong.

#### The deep dive

Pick **one** area the reader is working on or about to decide about, and
explain how it works *now*. Not what changed — what it is. The test is that
someone who has been away for a month could make a call about that area after
reading two pages.

This needs real research, not a diff summary. Read the models, the routes, the
jobs, the places that write and the places that read. Follow one path all the
way through: what enters, what stores it, what transforms it, what reads it
back. Where you find a surprise — two sources of truth, a table nothing reads,
a route with no auth, a queue with no retry — that surprise *is* the deep dive.

Build it out of figures, not paragraphs:

- a `schema` figure of the entities involved and how they relate
- a `table` of the routes, events or jobs that touch them
- captions naming what to notice, and one sentence on what it means

Rotate the subject nightly, and say at the top why this area was chosen —
"because three of this week's PRs touched it and none of them agreed about
where matching state lives" is a better opening than a title.

Writing rules:

- **Captions, not paragraphs.** More than ~40 words of prose means the content
  belongs on the call instead.
- **Every chart earns a caption saying what to notice.** Uncaptioned charts are
  decoration.
- **Never chart lines-changed or files-touched per PR.** It is a fact about the
  diff, not about the product: it says a change touched `prisma` without saying
  what it did to the data, and it is stale the next morning. Chart the thing
  the change acts on instead — the tables, the routes, the events, the states.
  If nothing structural is worth drawing for a ticket, give it no figure at
  all; a caption alone is honest, a churn bar is filler.
- **Spot colour once per page at most.** Used twice it marks nothing.
- **`decision` is only for genuine taste-and-scope questions.** Correctness is
  the reviewer's job, not the reader's over coffee.

Render it:

```bash
node press/bin/render.mjs <edition.json> --out <outDir>/<date>.pdf
```

`--keep-html` prints the intermediate HTML while iterating. Check the page
count: more than about ten pages means it is trying to be complete rather than
useful. Cut ticket pages before you cut the deep dive — a ticket page the
reader could have got from the PR list is the cheapest thing in the paper.

Figures available: `treemap`, `bar`, `status`, `age`, `spark`, `schema`,
`table`. `schema` takes `entities` (each with `fields`, optional `column` 0-2,
optional `spot`) and `relations` (`from`, `to`, `label`). `table` takes
`columns` and `rows`, where a row is an array of cells or
`{cells, spot}`. Both are defined in `press/lib/charts.mjs` — read it before
inventing a figure it cannot draw.

#### 5b. The call brief

The brief is the prompt the phone assistant is given. It is spoken, so write it
to be *said*, not read.

- **Three to six decisions, hardest first.** The caller may hang up at four.
- **Each decision states the situation in two sentences, then asks one
  question with named options.** "Separate table, or leave it?" — not "what do
  you think?"
- **Carry the context an interruption will need.** The caller will ask "what
  else reads it?" Put the answer in the brief or the assistant will invent one.
- **Name anything you could not decide** and say plainly it needs their eyes.
- **No numbers that only make sense written down.** No SHAs, no percentages to
  two decimal places, no file paths deeper than one segment.

End the brief with the wrap-up line: the assistant should say the transcript
goes to their agent, and hang up.

#### 5c. The decisions manifest

Write `<outDir>/<date>.decisions.json` alongside the brief — one entry per
decision you just asked for, in the same order:

```json
[
  { "id": 1, "prs": [412, 418], "tickets": ["PLAT-501"],
    "repo": "/absolute/path/to/repo",
    "question": "land together today, or take their turn?",
    "options": ["expedite both", "normal queue"] }
]
```

This exists because of a tension in the brief itself. The brief is *spoken*, so
it carries no pull request numbers — "the outreach proxy fix", never "PR 418".
That is right for the ear and useless for the return leg, which has to know
which pull request a decision was about. The manifest puts the identifiers
back.

Without it, applying a decision means guessing what "the second one" referred
to, and a wrong guess merges the wrong code. Write it every time, even when
there is one decision.

Keep it under ~4000 characters — the Worker rejects more, and anything longer
is not a nine-minute call.

### 6. Park the paper for wake-up

```bash
screenless settings --json          # callAt, and the machine's timezone
screenless mail <outDir>/<date>.pdf --at <that callAt, or a little before> \
  --subject "screenless · <repo> · <date>"
```

Read the settings here rather than in step 7: this step needs the call time
too, and a step that depends on a value the *next* step fetches only works
while nothing fails. The recipient is not passed — it is the address confirmed
against the account, and `screenless email` is how it changes.

This hands the PDF to the Worker, which holds it and sends at the requested
local time. Delivery is the Worker's job rather than an MCP's for one reason:
it cannot be assumed that a reader has Slack or a mail MCP connected, and a
product whose second surface only works for people with the right integration
is a product with two different stories.

It does **not** send immediately. The paper should be waiting when the reader
wakes, not buzzing at 03:00.

If the send is refused, say so and leave the PDF at its path. A paper on disk
is recoverable; a failed run is not.

### 7. Park the call

```bash
screenless settings --json          # read callAt and the machine's timezone
screenless call "<brief>" --at      # park for the configured call time
```

Bare `--at` uses the user's own call time, so this step never needs to know it.

**If the call time has already passed today** — you are running as a catch-up
after the laptop was shut overnight — park it held instead, and say so:

```bash
screenless call "<brief>" --hold
```

A held brief is not dialled. It waits for the user to ring the number back,
which is the right behaviour at 09:40: they are already awake and already at a
screen, and a surprise call ten minutes after they open the laptop is worse
than a note telling them it is ready.

Confirm what was parked, and when it will ring.

## When this runs

Once a night, at **03:00**, by launchd — see `loop/README.md` for the plist.
The schedule has two properties that matter:

- **If the machine is asleep or off at 03:00, the run happens when it next
  wakes.** launchd holds missed calendar jobs. That is the "first thing when
  the laptop opens" behaviour, and it is why the catch-up branch in step 7
  exists rather than being theoretical.
- **It runs at most once per day.** `loop/nightly.sh` stamps a date file and
  exits early if today is already done, so a laptop that wakes four times
  before breakfast still produces one paper.

If a step fails, ship a shorter paper and a shorter call. A missing section is
a finding; a missing paper is a broken product.

## What this deliberately does not do

- **It does not ask you anything.** Every question belongs on the call, which
  is interruptible. Both artefacts are produced unattended.
- **It does not merge, comment, or move tickets.** It only reads. Applying
  decisions happens after the call, from the transcript, in a separate run — so
  a bad night produces a bad paper and nothing worse.
- **It does not decide when to call.** That is the user's setting, read at run
  time.
- **It does not send anything itself.** Both surfaces are handed to the Worker
  and released on the user's schedule — the laptop that built them at 03:00 is
  usually shut by the time either should arrive.
- **It does not try to be complete.** Six good pages beat thirty accurate ones,
  and four real decisions beat a read-through of the backlog.
