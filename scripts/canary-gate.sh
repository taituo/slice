#!/usr/bin/env bash
# Canary health gate: watches canary-region orders and fails the release if they degrade.
# Usage: canary-gate.sh <api-url> <admin-key> <comma-separated-regions> [minutes]
set -euo pipefail
API="$1"; KEY="$2"; REGIONS="$3"; MINUTES="${4:-30}"
MAX_FAIL_RATE="${MAX_FAIL_RATE:-0.05}"

deadline=$(( $(date +%s) + MINUTES * 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  orders=$(curl -sf "$API/v1/orders?limit=500" -H "x-admin-key: $KEY")
  stats=$(echo "$orders" | jq --arg r "$REGIONS" '
    ($r | split(",")) as $regions
    | [.orders[] | select(.region as $x | $regions | index($x))] as $o
    | { total: ($o | length), failed: ([$o[] | select(.status == "failed")] | length) }')
  total=$(echo "$stats" | jq .total); failed=$(echo "$stats" | jq .failed)
  echo "$(date -u +%H:%M) canary orders=$total failed=$failed"
  if [ "$total" -ge 20 ] && awk -v f="$failed" -v t="$total" -v m="$MAX_FAIL_RATE" 'BEGIN { exit !(f / t > m) }'; then
    echo "Canary failure rate above $MAX_FAIL_RATE — rolling back"; exit 1
  fi
  sleep 60
done
echo "Canary healthy"
