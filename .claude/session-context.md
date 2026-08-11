# Session Context

## Current Focus

Build session-minder Phase 2.b — the `sm` terminal picker — to completion against
the ratified plan `docs/superpowers/plans/2026-08-10-session-minder-phase2b-picker.md`.
Eight tasks: Herdr error split, attach route consumption, `GET /api/sessions`, then
the CLI (args/api, rows, outcome, pick+main), then live verification.

John's instruction: proceed autonomously, ask questions up front, stop only for a
true blocker.

## Honcho Context

Phase 2.b was deliberately narrowed from "dashboard" to **resuming work, solely** —
an on-demand `sm` picker, no web UI, no browse/curation, no daemon. Settled
behaviors: on-demand invocation; noise hidden with an `sm --all` escape hatch;
titles read-only with fallback chain title → project basename → Hermes surface;
existing bearer token is sufficient (terminal runs on/attached to vps8).

Inherited hard constraints from 2.a: Hermes panes report no `agent_session`, so
Hermes is spawn-only; `spawned` ≠ usable (Kimi trust gate); attach outcomes are
`focused`/`spawned`/`degraded` and degraded is a 200 with a manual recovery path.

Process rules John holds firmly: tests must name the mutant they kill and the
implementer must prove the kill; a green suite is not evidence an external
contract holds; visible diagnosis before changing code from a live finding;
sudo is John's.

## Key Decisions

- **Executing the plan directly in this session** (`superpowers:executing-plans`),
  not via subagents. The plan permits either; the harness here says don't dispatch
  the Agent tool unmasked, and subagents can't get interactive Bash approvals,
  which this build needs (npm test, psql, curl).
- Tasks 1–7 are fully in my hands. Task 8 needs John: sudo service restart, and
  live pane observation.

## Notes

- Session started: 2026-08-10
