#!/usr/bin/env bash
# Rings the line from the scripted test caller with five short questions and
# prints how long the voice took to answer each, from the Worker's own logs.
# The ring stands in for TEST_RING_AS and is pinned to a repo no watcher runs
# in, so it takes the unwatched path and no fork is involved.
#
#   TEST_RING_SECRET=… scripts/bench-ring.sh ['{"pad":12000}']
#
# The optional JSON is merged into the request: `pad` (chars of brief-like
# filler in the instructions), `instructions` (replace them), `record`
# (dual-channel recording of the caller's leg; its URL is logged).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TEST_RING_SECRET:?set TEST_RING_SECRET}"
extra=${1:-'{}'}
log=$(mktemp)
npx wrangler tail --format json >"$log" 2>&1 &
tail_pid=$!
trap 'kill $tail_pid 2>/dev/null; rm -f "$log"' EXIT
sleep 5
as=$(grep -o '"TEST_RING_AS": *"[^"]*"' wrangler.jsonc | cut -d'"' -f4)
jq -n --arg as "$as" --argjson extra "$extra" '{as: $as, repo: "latency-bench", script: [
  {pause: 4, say: "Hi. Quick question. What is the capital of France?"},
  {pause: 7, say: "And how many days are there in a week?"},
  {pause: 7, say: "What colour is the sky on a clear day?"},
  {pause: 7, say: "Name one fruit that is yellow."},
  {pause: 7, say: "What is two plus three?"},
  {pause: 7, say: "Thanks, that is all. Goodbye."},
  {pause: 4}
]} + $extra' | curl -sf -X POST -H "X-Test-Secret: $TEST_RING_SECRET" -H 'content-type: application/json' \
  -d @- https://screenless.sh/admin/test-ring >/dev/null
until grep -q 'phone stream closed\|voice unavailable' "$log"; do sleep 3; done
sleep 4
grep -oE '\\"ev\\":\\"live (turn|rtt)\\"[^}]*|test recording[^}]*' "$log" | sed 's/\\"/"/g; s/"call":"[^"]*",//'
