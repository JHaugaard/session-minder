#!/usr/bin/env python3
"""Codex lifecycle adapter. Metadata only; no transcript or prompt ingestion."""
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import urllib.request

UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.I)
ROOT = Path(__file__).resolve().parents[2]


def capture_payload(payload, env, host):
    event = payload.get("hook_event_name")
    if event == "SessionStart":
        if payload.get("source") not in ("startup", "resume"):
            return None  # Compaction is not a new visit.
        event = "start"
    elif event == "SessionEnd":
        event = "end"
    else:
        return None
    sid, cwd = payload.get("session_id"), payload.get("cwd")
    if not isinstance(sid, str) or not UUID.fullmatch(sid):
        return None
    if not isinstance(cwd, str) or not cwd.startswith("/"):
        return None
    body = dict(platform="codex", external_session_id=sid, event=event,
                host=host, project_path=cwd)
    if env.get("HERDR_ENV") == "1" and env.get("HERDR_SOCKET_PATH") and env.get("HERDR_PANE_ID"):
        body["herdr"] = {key: env.get("HERDR_" + key.upper(), "") for key in
                         ("session", "workspace_id", "tab_id", "pane_id", "socket_path")}
    return body


def config(env):
    values = {}
    try:
        for line in (ROOT / ".env.local").read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.strip().startswith("#"):
                values[key.strip()] = value.strip()
    except OSError:
        pass
    return {**values, **env}


def local_host(env):
    if env.get("SESSION_MINDER_HOST_NAME"):
        return env["SESSION_MINDER_HOST_NAME"]
    try:
        result = subprocess.run(["tailscale", "status", "--json"], capture_output=True,
                                text=True, timeout=0.4, check=True)
        name = json.loads(result.stdout)["Self"]["DNSName"].split(".")[0]
        if name:
            return name
    except (OSError, subprocess.SubprocessError, ValueError, KeyError):
        pass
    return socket.gethostname()


def session_name(sid, env):
    # Codex's `title` can be the first prompt. Only its explicit `name` is
    # curation, so never fall back to title, preview, or first_user_message.
    home = Path(env.get('CODEX_HOME', str(Path.home() / '.codex')))
    stores = sorted((p for p in home.glob('state_*.sqlite') if re.fullmatch(r'state_\d+\.sqlite', p.name)),
                    key=lambda p: int(p.stem.split('_')[1]), reverse=True)
    if not stores:
        return None
    try:
        conn = sqlite3.connect(stores[0].resolve().as_uri() + '?mode=ro', uri=True, timeout=0.1)
        try:
            row = conn.execute('SELECT name FROM threads WHERE id = ?', (sid,)).fetchone()
        finally:
            conn.close()
        name = row[0].strip() if row and isinstance(row[0], str) else ''
        return name if 0 < len(name) <= 60 else None
    except (OSError, sqlite3.Error):
        return None


def report_herdr(body, source):
    """Supply the exact thread identity; native Herdr detects TUI readiness."""
    ref = body.get("herdr")
    if not ref or body["event"] != "start":
        return
    request = dict(id="session-minder", method="pane.report_agent_session", params=dict(
        pane_id=ref["pane_id"], source="herdr:codex", agent="codex",
        agent_session_id=body["external_session_id"], session_start_source=source))
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(0.3)
        conn.connect(ref["socket_path"])
        conn.sendall((json.dumps(request) + "\n").encode())
        response = json.loads(conn.makefile("rb").readline(65536))
        if "error" in response:
            raise ValueError("Herdr rejected session identity")


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        cfg = config(os.environ)
        body = capture_payload(payload, os.environ, local_host(cfg))
        if body is None:
            return
        try:
            report_herdr(body, payload.get("source"))
        except (OSError, ValueError):
            print("session-minder: Herdr identity unavailable", file=sys.stderr)
        token = cfg.get("SESSION_MINDER_TOKEN")
        if not token:
            print("session-minder: capture token is missing", file=sys.stderr)
            return
        url = cfg.get("SESSION_MINDER_URL", "http://vps8-core:3000").rstrip("/")
        request = urllib.request.Request(url + "/api/sessions/capture",
            data=json.dumps(body).encode(), method="POST", headers={
                "Authorization": "Bearer " + token, "Content-Type": "application/json"})
        # Bounded synchronous delivery preserves start/end order, including
        # short visits. Codex's SessionEnd hook budget is three seconds.
        name = session_name(body['external_session_id'], os.environ)
        with urllib.request.urlopen(request, timeout=0.7 if name else 1.5) as response:
            response.read(1024)
        if name:
            title = dict(platform='codex', external_session_id=body['external_session_id'],
                         title=name, if_absent=True)
            request = urllib.request.Request(url + '/api/sessions/title', data=json.dumps(title).encode(),
                method='PUT', headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=0.7) as response:
                response.read(1024)
    except Exception:
        # Never print a payload, URL, token, transcript or exception details.
        print("session-minder: capture failed", file=sys.stderr)


if __name__ == "__main__":
    main()
