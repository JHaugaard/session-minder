#!/usr/bin/env bash
# Hermes on_session_end shell hook. Requires jq.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

# Same Tailscale-short-name derivation as session-start.sh — the two events
# must agree on `host`, or the end event upserts a second row instead of
# matching the one the start event created.
host="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | cut -d. -f1)"
[ -z "$host" ] && host="$(hostname)"

body="$(jq -n --arg sid "$session_id" --arg host "$host" \
  '{platform: "hermes", external_session_id: $sid, event: "end", host: $host}')"

curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${SESSION_MINDER_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
