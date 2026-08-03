#!/usr/bin/env bash
# Claude Code SessionStart hook. Reads the hook's JSON payload from stdin,
# fires a fire-and-forget capture POST. Never blocks or fails the session:
# all errors are swallowed (spec: Capture Pipeline — non-blocking by design).
# jq is used both ways: parsing the payload and building the POST body, so
# paths with spaces/quotes stay valid JSON.
#
# Deliberately self-contained — no shared lib. Each machine running Claude Code
# gets its own copy of this file, so a sourced helper would be one more thing
# to keep in sync across mbp/mini/vps8.

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
  '{platform: "claude_code", external_session_id: $sid, event: "start", host: $host}
   + (if $cwd == "" then {} else {project_path: $cwd} end)')"

setsid curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${SESSION_MINDER_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
