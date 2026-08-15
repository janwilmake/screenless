#!/usr/bin/env bash
#
# One nightly run of the screenless loop.
#
# Invoked by launchd at 03:00, and again whenever the machine wakes from a
# 03:00 it slept through. Everything here exists to make that second case safe:
# a laptop opened at 08:40 must produce exactly one paper, not one per wake.

set -euo pipefail

REPO_DIR="${SCREENLESS_REPO_DIR:-$HOME/Desktop/oss/screenless}"
STATE_DIR="${SCREENLESS_STATE_DIR:-$HOME/.screenless}"
LOG_DIR="$STATE_DIR/logs"
STAMP="$STATE_DIR/last-run"

mkdir -p "$LOG_DIR"

today="$(date +%Y-%m-%d)"
log="$LOG_DIR/$today.log"

say() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$log"; }

# ---------------------------------------------------------------- once a day

# launchd re-fires a missed calendar job on wake, and a laptop lid can open
# four times before breakfast. The stamp is what turns "run on wake" into "run
# once".
if [ "${SCREENLESS_FORCE:-}" != "1" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$today" ]; then
  say "already ran today — nothing to do"
  exit 0
fi

# ------------------------------------------------------------------ preflight

if ! command -v claude >/dev/null 2>&1; then
  say "claude CLI not found — cannot run the loop"
  exit 1
fi

if ! command -v screenless >/dev/null 2>&1; then
  say "screenless CLI not found — run the installer first"
  exit 1
fi

# Nothing to park a brief against, and no subscription to spend. Bail before
# doing the expensive reading.
if ! screenless whoami >/dev/null 2>&1; then
  say "not set up — run \`screenless setup\`"
  exit 1
fi

# Not fatal on its own: the paper is still worth building on a laptop that is
# tethered or offline-ish, and the parking step will report its own failure.
if ! curl -fsS --max-time 10 https://api.screenless.sh/health >/dev/null 2>&1; then
  say "warning: api.screenless.sh unreachable — the call may not park"
fi

# ----------------------------------------------------------------------- run

say "starting nightly run"

# Stamped before the run, not after. A crash mid-run must not turn into four
# more attempts over breakfast; a missed night is cheaper than four papers and
# four phone calls.
printf '%s' "$today" > "$STAMP"

cd "$REPO_DIR"

if claude -p "Run the screenless nightly loop for tonight." \
    --permission-mode acceptEdits \
    >>"$log" 2>&1; then
  say "done — see $log"
else
  status=$?
  say "run failed with status $status — see $log"
  exit "$status"
fi
