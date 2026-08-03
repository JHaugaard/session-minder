#!/usr/bin/env bash
# Hermes on_session_end shell hook. Requires jq.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

# Same Tailscale-short-name derivation as session-start.sh — `host` isn't
# part of the unique constraint, so the two events should agree on it. If
# they don't, the row still matches on (platform, external_session_id); the
# upsert's ON CONFLICT clause doesn't touch `host`, so the start event's
# value is what persists.
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

body="$(jq -n --arg sid "$session_id" --arg host "$host" \
  '{platform: "hermes", external_session_id: $sid, event: "end", host: $host}')"

setsid curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
