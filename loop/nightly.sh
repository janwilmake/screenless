#!/usr/bin/env bash
#
# One nightly run of the screenless loop.
#
# Invoked by launchd at 03:00, and again whenever the machine wakes from a
# 03:00 it slept through. Everything here exists to make that second case safe:
# a laptop opened at 08:40 must produce exactly one paper, not one per wake.

set -euo pipefail

STATE_DIR="${SCREENLESS_STATE_DIR:-$HOME/.screenless}"
REGISTRY="$STATE_DIR/projects.json"
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

# Repos registered with `screenless init`. Kept here rather than in the skill
# because which projects run tonight is a property of this machine, not of any
# one checkout.
if [ ! -f "$REGISTRY" ]; then
  say "no projects registered — run \`screenless init\` in a repo first"
  exit 0
fi

projects="$(node -e '
  const fs = require("fs");
  try {
    const list = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (Array.isArray(list)) console.log(list.join("\n"));
  } catch { /* unreadable registry is the same as no projects */ }
' "$REGISTRY")"

if [ -z "$projects" ]; then
  say "registry is empty — run \`screenless init\` in a repo first"
  exit 0
fi

say "starting nightly run"

# Stamped before the run, not after. A crash mid-run must not turn into four
# more attempts over breakfast; a missed night is cheaper than four papers and
# four phone calls.
printf '%s' "$today" > "$STAMP"

failures=0
while IFS= read -r project; do
  [ -n "$project" ] || continue
  if [ ! -d "$project" ]; then
    say "skipping $project — no longer there"
    continue
  fi

  say "running for $project"
  cd "$project"

  # One project failing must not cost the others their night.
  if claude -p "Run the screenless nightly loop for this repo." \
      --permission-mode acceptEdits \
      >>"$log" 2>&1; then
    say "done: $project"
  else
    failures=$((failures + 1))
    say "failed: $project — see $log"
  fi
done <<EOF
$projects
EOF

say "finished with $failures failure(s) — see $log"
[ "$failures" -eq 0 ]
