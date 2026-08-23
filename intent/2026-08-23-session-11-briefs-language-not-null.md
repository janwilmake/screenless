# Session 11 — briefs.language NOT NULL broke every parked brief

author: Wijnand (wijnand@hyre.io), via Claude Code in the hyre session

The morning call did not ring at 08:00. The nightly loop built the brief and
the decisions manifest, but every `screenless call --at` / `--hold` was
rejected by the Worker with:

    D1_ERROR: NOT NULL constraint failed: briefs.language

Root cause: session 10's Realtime move dropped language from the product ("the
voice understands and answers in whatever language the caller speaks"). The
Worker code stopped writing `briefs.language` — `Brief` in
`worker/src/schedule.ts` no longer has the field and `saveBrief` no longer
binds it — but the **live D1 table kept the column**, `NOT NULL` with no
default. Every INSERT from the new code failed. `schema.sql` also still
declared the column, so fresh installs would diverge from the code the same
way.

Fix, applied from the hyre session with Wijnand's go-ahead ("check screenless
repo and see to fix this bug"):

1. `ALTER TABLE briefs DROP COLUMN language` on the remote `screenless` D1
   database. `briefs` is transient (one parked brief per phone, TTL swept), so
   the drop loses nothing.
2. Removed `language TEXT NOT NULL,` from the `briefs` table in
   `worker/schema.sql` so schema and code agree again.
3. Verified: `screenless call "<brief>" --hold` now returns
   `✓ parked — held until you ring in`. Today's missed brief is parked held.

Left alone: `users.language` (schema line 41, `DEFAULT 'en'`) — `UserRow` in
`worker/src/db.ts` still carries it and the default means inserts cannot fail.
Retiring that column fully is a separate cleanup, not this fix.

Lesson for the next migration: when a release stops writing a column, the same
release must drop the column or give it a default on the **live** database —
the code deploy and the D1 schema do not move together on their own.

## Prompts

> somehow this morning i didnt get a call from screenless at 8am can u see why
> not?

> ah u have an old version of the cli. pls get the latest

> also check screenless repo (/work/screenless) and see to fix this bug
