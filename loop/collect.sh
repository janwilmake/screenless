#!/usr/bin/env bash
#
# Applies the decisions from any call that has finished and not been acted on.
#
# Runs every five minutes, forever, and almost always does nothing: the Worker
# answers 204 when there is no call newer than the one already applied, so the
# quiet path is one small request and an exit. That is the whole reason this is
# an interval job rather than a daemon — a daemon would cost a process, a
# restart policy, and a silent death nobody notices, to achieve the same
# latency.
#
# launchd runs a missed interval job when the machine wakes, so a call taken
# while the laptop was shut is applied within minutes of opening it.

set -euo pipefail

STATE_DIR="${SCREENLESS_STATE_DIR:-$HOME/.screenless}"
LOG_DIR="$STATE_DIR/logs"
BIN="${SCREENLESS_BIN:-$STATE_DIR/bin/screenless}"

mkdir -p "$LOG_DIR"
log="$LOG_DIR/$(date +%Y-%m-%d).log"
say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$log"; }

command -v claude >/dev/null 2>&1 || exit 0
[ -x "$BIN" ] || BIN="$(command -v screenless || true)"
[ -n "$BIN" ] || exit 0

# Exit 3 means "nothing finished that has not been applied", which is the
# expected answer almost every time. Anything else non-zero is a transient
# problem — offline, mid-call — and the next tick retries.
if ! call_id="$("$BIN" collect 2>/dev/null)"; then
  exit 0
fi
[ -n "$call_id" ] || exit 0

say "applying decisions from $call_id"

# Start in a registered project rather than $HOME: the agent needs a repo to
# act on, and Claude Code resolves tools and MCPs relative to where it runs.
# The manifest names its own repo, so this is a sensible default rather than
# the answer — a machine with several projects still routes by manifest.
project="$(node -e '
  const fs = require("fs");
  try {
    const list = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (Array.isArray(list) && list[0]) console.log(list[0]);
  } catch { /* no registry yet */ }
' "$STATE_DIR/projects.json" 2>/dev/null || true)"
[ -n "$project" ] && [ -d "$project" ] && cd "$project"

# Referred to by skill name, not by a path. Anyone who installed with the
# one-liner has the skill at ~/.claude/skills/screenless/APPLY.md and no
# checkout of this repo at all, so "follow loop/APPLY.md" pointed at nothing.
if claude -p "A screenless call just finished. Use the screenless-apply skill: read the transcript with 'screenless transcript --json', find the decisions manifest the brief was written with, and apply what was decided." \
    --permission-mode acceptEdits \
    >>"$log" 2>&1; then
  # Marked only on success, so a failed run is retried rather than written off.
  "$BIN" applied "$call_id" >>"$log" 2>&1 || true
  say "applied $call_id"
else
  say "apply failed for $call_id — will retry on the next tick"
fi
