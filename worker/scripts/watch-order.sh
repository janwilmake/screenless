#!/usr/bin/env bash
# Polls the Telnyx number order until it leaves review, then exits.
# Exit 0 = active, 1 = failed/rejected, 2 = timed out.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
K=$(grep '^TELNYX_API_KEY=' "$DIR/.dev.vars" | cut -d= -f2-)
NUM="+31850835195"
INTERVAL=300      # 5 minutes
MAX_HOURS=12

deadline=$(( $(date +%s) + MAX_HOURS * 3600 ))

while [ "$(date +%s)" -lt "$deadline" ]; do
  status=$(curl -s -m 25 -H "Authorization: Bearer $K" \
    "https://api.telnyx.com/v2/phone_numbers" \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin).get('data',[])
except Exception:
    print('poll-error'); raise SystemExit
for p in d:
    if p.get('phone_number')=='$NUM':
        print(p.get('status','unknown')); break
else:
    print('not-found')
" 2>/dev/null)

  echo "[$(date -u +%H:%M:%SZ)] $NUM -> $status"

  case "$status" in
    active)
      echo "ACTIVATED"
      exit 0
      ;;
    *rejected*|*failed*|*cancel*)
      echo "ORDER PROBLEM: $status"
      exit 1
      ;;
  esac

  sleep "$INTERVAL"
done

echo "TIMEOUT after ${MAX_HOURS}h"
exit 2
