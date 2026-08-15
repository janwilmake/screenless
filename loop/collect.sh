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

# The agent is given the call id rather than the transcript itself: it should
# fetch the transcript, find the matching decision manifest, and act. Passing
# the text here would make this script the thing that decides what "the second
# one" referred to, which is precisely the judgement it is unqualified to make.
if claude -p "A screenless call just finished. Apply its decisions: run 'screenless transcript --json', find the matching decisions manifest in ~/screenless/press/, and follow loop/APPLY.md." \
    --permission-mode acceptEdits \
    >>"$log" 2>&1; then
  # Marked only on success, so a failed run is retried rather than written off.
  "$BIN" applied "$call_id" >>"$log" 2>&1 || true
  say "applied $call_id"
else
  say "apply failed for $call_id — will retry on the next tick"
fi
