# Codex integration — 2026-09-05

Codex is a native fourth platform. `sm` continues to use the same list and attach
API; it never wraps Codex in Hermes or sends agent-bridge messages.

## Verified local contract

- Codex CLI 0.153.4; Herdr 0.7.5; Node 24 on vps8.
- Native resume is `codex resume <UUID>` (UUIDv7 is valid).
- `SessionStart` supplies `session_id`, `cwd`, `source`, and `transcript_path`.
  Startup and resume hooks ran at the **first user turn**, not while an empty
  TUI sat idle. The end hook ran on `/quit`, with the same ID and reason `other`.
- Local `state_5.sqlite` indexes `threads.id`, `rollout_path`, and explicit
  `name`. The rollout begins with `session_meta.payload.id`. The adapter reads
  this metadata only to validate a local resume; it does not ingest transcripts.
- `threads.title` can contain the first prompt. Only explicit `name` values
  of at most 60 characters are imported, and only into blank session-minder
  titles. `/rename` followed by `/quit` was verified to import the name.
- Herdr's exact wire method is `pane.report_agent_session`. A start hook
  supplies `source: herdr:codex`, `agent: codex`, and the native UUID. Herdr clears
  that identity when Codex exits. No built-in Herdr Codex integration was needed
  for this capture/focus/resume path.
- Herdr may return a newly created tab before its shell is ready, and reject
  `agent.start` with `agent_pane_busy`. The client retries only that Codex
  pre-launch rejection for up to three seconds. Other failures are not retried.
  Herdr also returned `launch_pending: true`; a successful spawn response is
  not proof that the TUI has finished loading.

## Behavior

The hooks post only platform, native ID, host, project directory, lifecycle event,
and optional Herdr pane coordinates. Delivery is synchronous and bounded to fit
Codex's three-second end-hook budget. Errors are reported without credentials or
payloads and never fail the Codex session. There is no offline delivery queue.

Resuming a captured Codex thread clears `ended_at`, refreshes its location, and
preserves the original `started_at`, title, note, and row ID. An end-only event
retains the working directory so the session can still be resumed. Other
platforms retain their existing capture behavior. Codex short visits are not
automatically hidden as noise without a reliable message count.

Before opening a new Codex pane, the service checks the local index and matching
rollout metadata. Missing, unreadable, or unfamiliar state yields
`codex_session_unavailable` without creating a tab. This check needs Node 22+;
other platforms still work without its SQLite built-in. State-format changes
fail closed and need adapter revalidation. Foreign-host sessions still return
the native command to run on that host.

Before the first resumed turn, the old end state/live marker can remain visible;
the resume hook updates both at that turn. The existing Herdr name uniqueness
guard prevents a second successful launch of the same session in that interval.
The list still sorts by original start time and searches title, path and platform,
not transcript content. Historical backfill is not part of this integration.

## Installation

1. Deploy the branch source to the existing installation checkout.
2. Apply `db/03-codex.sql` as `_sessionminder_role`. Fresh installations use
   `db/02-tables.sql`, which already includes Codex. The migration preserves the
   existing `(platform, external_session_id)` uniqueness constraint.
3. Merge the two definitions from `hooks/codex/hooks.json` into
   `~/.codex/hooks.json`. Preserve any existing hooks. The supplied commands point
   at `/home/john/dev/active/session-minder/hooks/codex/capture.py`.
4. Restart `session-minder` to load the new source.
5. Start Codex and review/trust the two metadata capture hooks through its hook
   review dialog or `/hooks`. Configured but untrusted hooks do not run.

No token is copied into Codex config. The Python hook resolves the repository's
`.env.local`, with environment overrides for `SESSION_MINDER_TOKEN`,
`SESSION_MINDER_URL`, and `SESSION_MINDER_HOST_NAME`. Python 3 and the existing
session-minder configuration are required. Native Codex names are read from
`CODEX_HOME`, or `~/.codex` when unset. The service must use the same Codex home as
the local CLI when validating resume targets.

The runbook supplied by the-super requests approval after the exact change list
and tests are available, before global configuration changes, restart, or commit.
Production rollout is a separate checkpoint from the isolated acceptance test.

## Verification

- `npm test` and `npm run typecheck`.
- `python3 -B test/codex_hook_test.py` covers lifecycle filtering, metadata-only
  delivery, explicit naming, and bounded failure behavior.
- Opt-in real PostgreSQL tests:
  `SESSION_MINDER_TEST_DATABASE_URL=<dedicated URL> npm test -- test/codex-db.test.ts`.
  The database must be named `session_minder_codex_test` and initially have no
  `_sessionminder` schema. The tests migrate the old schema, verify real lifecycle
  updates, title search and uniqueness, then remove only that test schema.
- Isolated acceptance used a loopback service on port 3107 and a separate database.
  Session `01a07250-998f-75f2-a7e8-4af29d34f9d8` appeared as open/live, was named
  `Codex integration acceptance`, focused through the API, and ended normally.
  The API then spawned `codex resume` with that same UUID; the restored TUI showed
  the original conversation. The initial failure exposed the shell-readiness
  race fixed above. A resumed turn reopened the same database row and restored
  the same UUID in Herdr. The real `sm codex` picker showed its name and live marker.

Official reference: https://learn.chatgpt.com/docs/hooks
