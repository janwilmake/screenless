# Session 8 — two loops, one question, two tickets

author: Jan Wilmake <jan@wilmake.com>

Ran from the hyre checkout, in the nightly linear-orchestrator session, so the
change here is small and the diagnosis is the substance.

Two Linear tickets in Todo asked the same question — does a draft written in
Gmail or Outlook reach Hyre through Aurinko:
[HYR2-972](https://linear.app/hyre2/issue/HYR2-972) opened by this loop's apply
leg at 20:27 on 19 Aug, and
[HYR2-973](https://linear.app/hyre2/issue/HYR2-973) opened by the orchestrator
at 20:28. Consolidated: 972 survives with 973's two unique details merged in,
973 closed as its duplicate.

The cause is the seam between the two loops. Applying the call of 19 Aug wrote
a comment on
[hyre#789](https://github.com/Hyre-AI-Recruiting/hyre/pull/789) quoting what the
caller decided — correctly, that is what `APPLY.md` asks for — but unsigned.
The orchestrator reads any comment without its own `🌙` marker as a person
talking to it, which is also right, because the caller *was* talking to it: that
comment is what put #789 back to draft and got the server-side draft store
built. Only the ticket was duplicate work.

So the fix is on both sides, because either alone leaks. Here: a pull request
comment is signed `<!-- ☎️ screenless call <id> -->` and carries an
`Already ticketed:` line, with the ticket opened *before* the comment so its id
can go in. In linear-orchestrator (pushed separately): read the comment for ids,
then search the tracker anyway, and only then create.

Housekeeping in the same sitting: `~/.claude/skills/screenless` was a copy, so
the first edit landed outside this repo. It is now three symlinks into
`loop/SKILL.md`, `loop/APPLY.md` and `press/`. The `intent` skill was the same
and got the same treatment. `multiclaude` was left alone deliberately — its
`~/Desktop/work` copy is not a git checkout, and the installed file is the newer
of the two. Note that `site/public/APPLY.md` is a build artifact of
`site/build.sh` and is now one commit stale.

## Prompts

- 06:02 — `theres 2 tickets about draft bidirectional sync in linear in todo it seems they are duplicates. consilidate that pls`
- 06:08 — `interesting. it seems like the screenless session made the ticket AND created a github comment, while the github comment spawned the orchestrator to create a ticket as well. I think we should fix this`
- 06:12 — `push the changes`
- 06:12 — `btw we are symlinking to the repos right? do this if not`
