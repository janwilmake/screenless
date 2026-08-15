---
name: press
description: Nightly loop that turns a repo's Linear tickets, GitHub pull requests, and code/docs into a printable newspaper about your own product, and schedules it to land in your inbox at wake-up. Runs unattended overnight. Use when the user says "run the press", "build tonight's paper", "start the press loop", or asks for the daily edition.
---

# press — the nightly paper

Builds one PDF per night about what your agents did to your product, and mails
it so it is waiting when you wake up.

The paper is not a status report and not a changelog. Its job is that reading it
leaves you understanding your own product better than you did yesterday — the
thing that quietly erodes when agents write most of the code. Optimise every
page for that, not for completeness.

## Project settings

Everything project-specific lives here. Point this at another repo by editing
this table and nothing else.

| Setting          | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| `REPO`           | `/Users/admin/Desktop/oss/hyre`                            |
| `TRACKER`        | Linear MCP                                                 |
| `TRACKER_TEAM`   | `Hyre Ops`                                                 |
| `TICKET_PREFIX`  | `HYR2`                                                     |
| `APP_URL`        | `http://localhost:5200` — for screenshots, if a dev server is up |
| `OUT_DIR`        | `~/screenless/press`                                        |
| `DELIVER_TO`     | the verified number's owner, via `screenless mail`          |
| `WAKE_TIME`      | `06:30` local                                               |
| `WINDOW_DAYS`    | `7`                                                         |

## The split that matters

Deterministic facts come from scripts. Judgement comes from you. Do not blur
these — a model re-deriving line counts wastes tokens and gets them wrong, and a
script deciding what is interesting produces a paper nobody reads.

| Scripts decide          | You decide                                     |
| ----------------------- | ---------------------------------------------- |
| Line counts, churn, ages | What this week's story is                     |
| Which areas exist        | Which areas are worth a page                   |
| PR metadata             | Which PRs carry a real product decision        |
| Chart geometry          | Which chart answers the question               |
| Page layout             | The headline, the standfirst, every caption    |

## Mode: one edition

Run these in order. Each step is cheap; the expensive one is step 4, so do not
start it until 1–3 have actually produced data.

### 1. Collect the deterministic facts

```bash
node press/bin/collect.mjs --repo REPO --days WINDOW_DAYS > /tmp/press-facts.json
```

Read the result. It gives you composition, churn by area (short and long
window), commits per day, staleness, open PRs with age and size, and the areas
each open PR touches. If `pullRequests.available` is `false`, `gh` is not
authenticated — say so in the edition rather than silently shipping a paper with
no PR pages.

### 2. Pull the tickets from Linear

Use the Linear MCP. You want, for `TRACKER_TEAM`:

- every ticket **In Progress** or **In Review**
- every ticket moved to **Done** inside the window
- for each: identifier, title, status, assignee, and the description — the
  description is where the *intent* lives, and intent is what the PR diff cannot
  tell you

Match tickets to pull requests by `TICKET_PREFIX` in the branch name, PR title,
or PR body. Record which tickets have no PR and which PRs have no ticket; both
are findings worth a line on the attention page.

### 3. Read enough code and docs to be right

Do not summarise a diff you have not read. For each candidate ticket page:

- `gh pr diff <n>` for the actual change
- the files it touches, when the diff alone is ambiguous
- the docs that describe the area it changes — if the change makes a document
  wrong, that is one of the most valuable lines the paper can carry

Keep this bounded: read deeply for the 4–6 tickets that will get a page, and not
at all for the rest.

### 4. Take screenshots, if a dev server is up

If `APP_URL` responds, use the browser to capture the surface each ticket page is
about — the screen as it looks *today*, before the change lands. Save PNGs
next to the edition file.

Skip this silently if the server is down. A paper with no screenshots still
prints; a paper that failed to build because a dev server was off does not.

### 5. Write the edition

Author `edition.json` next to the output PDF. The schema is documented by
`press/example/edition.json` — read that file before writing your first one.

Structure, in order:

1. **Masthead** — one headline naming the week's actual story, a standfirst of
   one or two sentences, and four stat tiles. The headline is a claim, not a
   label: "Matching moved to the centre of the product" beats "Weekly summary".
2. **A composition page** — treemap of what the product is made of.
3. **A movement page** — bar chart of churn by area, plus the ticket status bar.
4. **One page per ticket in flight**, four to six of them. Each gets a caption
   explaining what it does in plain language, a chart of the areas it touches,
   and — where one exists — the `decision` line naming what you need from the
   reader.
5. **An attention page** — PR ages, plus notes on what is not moving, what is
   stale, and which docs the week made wrong.

Rules for the writing:

- **Captions, not paragraphs.** If a page needs more than about 40 words of
  prose, its content belongs on the call instead.
- **Every chart earns a caption that says what to notice.** A chart with no
  caption is decoration.
- **Use the spot colour once per page at most.** It marks the one thing that
  matters; used twice it marks nothing.
- **`decision` is only for genuine taste-and-scope questions.** Correctness
  questions are for the reviewer, not for the reader over coffee.

### 6. Render

```bash
node press/bin/render.mjs <edition.json> --out OUT_DIR/<date>.pdf
```

Add `--keep-html` while iterating; it prints the intermediate HTML path so you
can open it in a browser without regenerating the PDF each time.

Check the page count. More than about eight pages means the edition is trying to
be complete rather than useful — cut ticket pages until it fits.

### 7. Schedule delivery for wake-up

```bash
screenless mail OUT_DIR/<date>.pdf \
  --at WAKE_TIME \
  --subject "screenless · <repo> · <date>"
```

This hands the PDF to the Worker, which holds it and sends at the requested
local time. It does not send immediately — the whole point is that it is waiting
when the reader wakes, not that it buzzes at 03:00.

## Mode: the loop

Run one edition per night, then sleep until the next.

1. Confirm `REPO` is clean enough to read — a half-finished rebase produces
   nonsense churn numbers. If `git status` is dirty in a way that would skew the
   data, note it in the edition rather than aborting.
2. Build the edition as above.
3. Schedule delivery.
4. Sleep until the next scheduled run.

If a step fails, still ship a shorter paper. A missing section is a finding; a
missing paper is a broken product.

## What this deliberately does not do

- **It does not ask you anything.** Every question belongs on the call
  (`rounds`), which is interruptible. The paper is one-way by design.
- **It does not merge, comment, or move tickets.** It only reads. Writeback is
  the call's job, so a bad night produces a bad paper and nothing worse.
- **It does not try to be complete.** Six good pages beat thirty accurate ones.
