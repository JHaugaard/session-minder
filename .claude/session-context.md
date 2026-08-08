# Session Context

## Current Focus

Push session-minder forward now that the Herdr gate has lifted. The Herdr Claude
Code and Hermes Agent integrations are installed (`herdr integration status`:
both `current`), which was the blocker on **Phase 2.a — Herdr integration
layer** per `docs/superpowers/specs/2026-08-03-session-minder-design.md`.

## Spike results (Phase 2.a, step 1) — verified live this session

The spike the spec called for is effectively complete; all checks were run
read-only from inside Herdr pane `w9` (session `herdr-4up`).

- **Hook coexistence — SAFE.** Herdr's Claude installer *appended*: `~/.claude/settings.json`
  keeps session-minder's `SessionStart` + `SessionEnd` and adds a second
  `SessionStart` entry (`herdr-agent-state.sh session`, timeout 10). Hermes has
  zero collision — session-minder uses `hooks.on_session_start/on_session_end`,
  Herdr uses the plugin system (`plugins.enabled: herdr-agent-state`).
- **Coexistence confirmed behaviorally.** 4 sessions captured since the Herdr
  install (12:45), across both platforms, including this one.
- **`HERDR_*` env vars ARE visible** to processes inside a pane:
  `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SESSION`,
  `HERDR_SOCKET_PATH`, `HERDR_ENV=1`. Capture enrichment needs no socket call.
- **The join key is real.** `pane.list` on pane `w9` returns
  `agent_session: {kind: "id", value: "8f7f70ae-9054-45b6-9f07-23e66f3a26b4"}` —
  byte-identical to the `external_session_id` in `_sessionminder.sessions` for
  this session. This was the load-bearing unknown.
- **Hermes side reads plausible but unobserved live** — the Herdr Hermes plugin
  does report `agent_session_id` from its `session_id` kwarg
  (`~/.hermes/plugins/herdr-agent-state/__init__.py`), but no Hermes pane has
  yet populated `agent_session`.
- **New trap for implementation:** the socket API rejects an integer `id`
  (`invalid type: integer 1, expected a string`). Request `id` must be a
  **string**. Not stated in the docs section the spec cites.

## Honcho Context

Queried `peer=john` (Dialectic, low reasoning). Consistent with the repo record:
Phase 2 is an integration problem, not a UI problem; the Herdr Claude
integration is *required* to populate `agent_session` ("no join key" without
it); the recorded gate was workspace-per-project comfort → back up
`settings.json` → inspect installer edits → verify session-minder hooks still
run → end-to-end test. As of Honcho's last write, integrations were still
uninstalled and hook preservation unverified. **Both are now resolved** —
this session's findings supersede that state.

## Key Decisions

- Treat Phase 2.a step 1 (spike) as **done**; findings above are the record.
- Remaining unknown to close opportunistically: Hermes CLI-pane `agent_session`
  population.

## Notes

- Service healthy: `session-minder.service` active, `healthz` → `{"ok":true}` on tailnet.
- `raw_metadata` is `{}` on every row — capture enrichment (2.a step 2) is unstarted.
- Uncommitted: spec (+286), `.docs/status.md`, this file.
- Herdr 0.7.5. Workspaces: w1 `~hermes`, w2 mccoy, w3 learning, w4 meanderings,
  w6 wayfinder, w9 session-minder.
- Session started: 2026-08-08 13:34 EDT (Claude Code `8f7f70ae-…`).
