#!/usr/bin/env bash
# Hermes on_session_start shell hook. Same JSON-stdin/fire-and-forget
# contract as the Claude Code hooks (spec: Capture Pipeline). Requires jq.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
# Hermes's payload does carry cwd, so project_path is capturable here even
# though the spec expected it to be absent for Hermes. Sent only when
# non-empty — many Hermes sessions (cron, timeout-spawned) have no meaningful
# working directory.
cwd="$(echo "$payload" | jq -r '.cwd // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

# Prefer the Tailscale short name over `hostname`: vps8's hostname is the
# provider-assigned `srv1086450`, but every other part of this system refers
# to that machine as `vps8-core`. Falls back to `hostname` where the tailscale
# CLI is absent.
host="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | cut -d. -f1)"
[ -z "$host" ] && host="$(hostname)"

# Token resolution: environment first, then the project's .env.local (mode 600)
# as a fallback. Kimi Code has no mechanism for setting hook environment
# variables at all, and daemon-launched hooks (systemd user units, cron) never
# source a shell profile — so relying on the environment alone fails silently
# with a 401 nobody sees.
token="${SESSION_MINDER_TOKEN:-}"
if [ -z "$token" ] && [ -r /home/john/dev/active/session-minder/.env.local ]; then
  token="$(sed -n 's/^SESSION_MINDER_TOKEN=//p' /home/john/dev/active/session-minder/.env.local | head -1)"
fi

# Herdr pane identity (spec Phase 2.a: capture enrichment). Herdr exports these
# into every pane it owns; outside a pane they are simply unset and the object
# is omitted. Guard mirrors Herdr's own hook script — HERDR_ENV=1 plus a
# non-empty socket path and pane id — so we agree with Herdr on what "inside a
# pane" means. This is a pure env read: no socket call, so it cannot add
# latency or a new failure mode to a fire-and-forget hook.
herdr_json=""
if [ "${HERDR_ENV:-}" = "1" ] && [ -n "${HERDR_SOCKET_PATH:-}" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
  herdr_json="$(jq -n \
    --arg session "${HERDR_SESSION:-}" \
    --arg workspace_id "${HERDR_WORKSPACE_ID:-}" \
    --arg tab_id "${HERDR_TAB_ID:-}" \
    --arg pane_id "${HERDR_PANE_ID:-}" \
    --arg socket_path "${HERDR_SOCKET_PATH:-}" \
    '{herdr: {session: $session, workspace_id: $workspace_id, tab_id: $tab_id,
              pane_id: $pane_id, socket_path: $socket_path}}' 2>/dev/null)"
fi

body="$(jq -n --arg sid "$session_id" --arg host "$host" --arg cwd "$cwd" \
  --argjson herdr "${herdr_json:-{\}}" \
  '{platform: "hermes", external_session_id: $sid, event: "start", host: $host}
   + (if $cwd == "" then {} else {project_path: $cwd} end)
   + $herdr')"

setsid curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
