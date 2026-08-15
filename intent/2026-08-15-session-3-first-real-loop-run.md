# Session 3 — the first real run of the nightly loop

A trial run of `loop/SKILL.md` end to end against a real target repo
(`~/Desktop/oss/hyre`), with the user watching. Read-only on the target; no
commits anywhere.

**What landed:** an 8-page edition at `~/screenless/press/2026-08-15.pdf`, its
`edition.json`, a 3,793-character call brief, and the collector facts, all in
`~/screenless/press/`. Nothing in this repo changed except this file.

**What did not land:** neither surface could be parked. `screenless mail`,
`screenless settings` and `screenless call` all die at
`config.load()` — there is no `~/.screenless/config.json` on this machine, so
the CLI has no session. The failure is local and happens before any network
call, so the Worker was never contacted. That also means the two risks the user
flagged in advance — the possibly-unverified Resend domain `screenless.sh`, and
the Telnyx silent-assistant bug — were **never exercised**. This run says
nothing about either.

**Findings about the toolkit, not the target repo:**

- `press/bin/collect.mjs` asks GitHub for `--limit 60` merged PRs and then
  filters to the window. hyre merged **159** in 7 days, so the collector
  reported 60 — a 2.6× undercount. Every `mergedRecently` figure it produces on
  a fast repo is a floor, not a count. This is the single biggest problem the
  run surfaced: a deterministic collector that silently under-reports is worse
  than one that errors, because the paper's whole premise is that scripts own
  the facts.
- The skill's step 6 tells you to pass `--at <the callAt from step 7>`, but
  step 7 is where you read it — and if `settings` fails you have no value to
  pass. The ordering only works when the CLI is healthy.
- `press/bin/render.mjs --keep-html` writes the HTML to its own temp dir, not
  next to `--out`, so previewing it means hunting through `/var/folders`.

**Prompts**

13:02 — You are doing the first real run of the screenless nightly loop, as a
trial, with a human watching in this window.

Read loop/SKILL.md in this repo and follow it end to end. That file is the
spec; this prompt only tells you what is different about a first run.

Target repo is /Users/admin/Desktop/oss/hyre. Read it, never modify it, never
commit or push anything there or here. It is a real working repo belonging to
the person watching.

The skill's Project settings table says REPO is that hyre path, tracker is the
Linear MCP, team 'Hyre Ops', ticket prefix HYR2, window 7 days, output to
~/screenless/press. Deliver the edition to jan@wilmake.com.

The screenless CLI should already be set up and subscribed. Use the
'screenless' command if it is on PATH; if it is not, run 'npm --prefix cli
install && npm --prefix cli run build' in this repo and use 'node
cli/dist/index.js' instead. Do not run 'screenless setup' and do not touch
billing.

Two things are known to be shaky, so report them rather than fighting them. The
Resend domain screenless.sh may still be pending verification, so 'screenless
mail' may fail at send time; parking it is still the correct step, just say
clearly if it errors. And Telnyx AI assistants have an open bug where a call
connects but stays silent — you are only parking a brief, not placing a call,
so it should not bite, but mention anything odd.

Work the steps in order and narrate what you find as you go: the collector
output, which tickets and PRs you matched, which four to six earn a page, and
which three to six earn a spoken decision. If a step fails, keep going and ship
a shorter paper — a missing section is a finding, a missing paper is a broken
run.

Finish by printing a short summary: where the PDF is, how many pages, whether
the mail parked, whether the brief parked and for when, and the single biggest
thing that made this run harder than it should have been. That last point is
the most valuable output of this trial, so be specific and blunt about it.

**Note on the premise:** the prompt said the CLI "should already be set up and
subscribed". It is not. That assumption is what cost the run both delivery
steps.
