#!/usr/bin/env bash
# Kimi Code SessionStart hook, matcher=startup only (see config.toml — resumed
# sessions are intentionally not wired to a matcher here, per spec Open
# Question #4: ignore resume rather than re-fire start). Requires jq.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
cwd="$(echo "$payload" | jq -r '.cwd // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

# Prefer the Tailscale short name over `hostname`: vps8's hostname is the
# provider-assigned `srv1086450`, but every other part of this system refers
# to that machine as `vps8-core`. Falls back to `hostname` where the tailscale
# CLI is absent.
host="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | cut -d. -f1)"
[ -z "$host" ] && host="$(hostname)"

body="$(jq -n --arg sid "$session_id" --arg host "$host" --arg cwd "$cwd" \
  '{platform: "kimi_code", external_session_id: $sid, event: "start", host: $host}
   + (if $cwd == "" then {} else {project_path: $cwd} end)')"

setsid curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${SESSION_MINDER_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
