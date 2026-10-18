# Session 17 — who may do what, in a file the owner writes

author: Jan Wilmake, via Claude Code (the Hyre watchloop session)

The prompts, verbatim:

> what are the permissions watchloop gives different ppl from slack? how can we give this same type of permissions through screenless?

> i just want it to be able to be configured upfront somehow and make it flexible to whatever system of permissions the user wants. wdyt wdy recommend?

> if we'd share this policy file between watchloop and screenless how would we name it?

> great. lets do it this way. make the required changes to screenless , watchloop, and hyre's repo

Agreed in the conversation before the build: screenless proves *who* is
calling, the owner writes *what* they may do. The file is
`.agents/permissions.md` (a neutral name, so watchloop's Slack loop and the
line read one list of people), in the repo so changes are reviewed, with
`~/.agents/permissions.md` allowed to narrow and never widen. YAML front
matter for the machine part (default, modes with a gate, callers), a
`## <mode>` section of free-text rules per mode, and a `## Never` section no
mode loosens.

Corrections given while it was built (by the session coordinating the three
repos):

- The account owner keeps today's full mode when no caller line matches them;
  `default` applies to teammates only. A line naming the owner's own email or
  phone may narrow the owner. Reason: the Hyre file lists people by email and
  should not need the owner's phone number to keep the owner working.
- `default:` holds a mode name (Hyre's file says `default: team`); a bare gate
  word is accepted too. Mode sections that say "everything `team` may do, and
  also" are plain rules, no inheritance.

What landed:

- `cli/src/permissions.ts`: a dependency-free parser for the flat front
  matter, resolution (exact email, phone, `*@domain`, `*`, default; wildcards
  never narrow the owner), the personal file narrowing (lower gate, both rule
  texts, every Never line), and the text block a request is given. A missing
  file is exactly the old behaviour; a broken one is reported once and
  ignored. Re-read on every poll when it changed on disk.
- The watcher caps each live call's mode by the caller's gate, runs nothing
  for `listen` (answers "noted for after the call"), adds the caller's block
  to every fork's system prompt, prints it with the finished call (and in
  `--json` as `permissions`), and drops the generic "untrusted" note when the
  file names the caller.
- Worker: the watcher sends `run=<patterns>` from its file; `sharedWatcher`
  prefers a session that runs the caller's requests over one that only shares
  its brief; such a teammate call hands off requests and takes progress
  updates like the owner's, with its own voice instructions; `livecall`
  carries the teammate's verified email and phone so the watcher can resolve
  them again.
