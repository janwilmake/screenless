# Session 7 — the intent convention becomes a skill

author: Jan Wilmake <jan@wilmake.com>

The `intent/` folder graduates. What lived here as a CLAUDE.md instruction is
now [janwilmake/intent](https://github.com/janwilmake/intent): a skill with
`/intent seed` (mine a contributor's own transcripts for the repo's history,
on [promptwash](https://github.com/janwilmake/promptwash)'s principles,
redaction mandated first), authorship on every file, inline links for tickets
and other carried intent, a weekly `Last updated:` contract on the summary,
and a pure-shell pre-push gate. This repo adopted its own child in the same
sitting: CLAUDE.md now points at the skill, the summary's date line became
machine-checkable, and the gate guards this very push.

A small proof along the way: the seed scanner, run against this repo, found a
prompt the hand-written session 6 file had missed — a 20:32 ask reversed at
20:33. It is restored there now, marked with where it came from.

Also this morning, same session, before this work: two `/screenless tick`
heartbeats per hour overnight, all quiet; the waiter was killed twice by the
harness and deliberately not re-armed a third time — the hourly heartbeat
carries the loop.

## Prompts

- 05:42 — `hey i wanna improve the intent/ folder of screenless. i feel like we could make this a skill ppl can adopt. the skill should be able to first initialize (/intent seed) by finding historical intent by looking in your transcripts. for this we can use https://github.com/janwilmake/promptwash or take its principles, then filter on the sessions that include this repo. seed is done once for every contributor and can get proposed if a contributor works in the repo and didnt know about /intent. from that moment on , intent can live in ur repo and should be triggered before every push. md files should have the author in them. linear tickets and other sources of intent should be made inline if urls or tools are used in the session. the summary has a last updated date and should be updated at least once a week, the pre-push /intent can check for that if its needed. ultimately its super important that assumptions and missing intent and the bigger goal becomes clear from the summary. these are great agent context and insights for humans also. so yes, make it a skill and move it to a repo janwilmake/intent. make it. thx.`
