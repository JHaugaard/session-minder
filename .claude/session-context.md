# Session Context

## Current Focus

Started as: build session-minder Phase 2.b (the `sm` picker) to completion against
the ratified plan. Finished that, then continued across a second day into
maintenance, token rotation, and the `/index-session` retarget so `sm` shows
titles.

## Honcho Context

Phase 2.b was narrowed from "dashboard" to **resuming work, solely** — an
on-demand picker, no web UI, no browse/curation, no daemon. Noise hidden behind
`sm --all`. Existing bearer token sufficient.

Process rules John holds firmly, all of which paid off: tests must name the
mutant they kill and the implementer must prove the kill; a green suite is not
evidence an external contract holds; visible diagnosis before changing code from
a live finding; sudo is John's.

## Key Decisions

- Executed the plan with `superpowers:executing-plans` rather than subagents —
  the build needed interactive Bash approvals (psql, curl, systemctl) that
  subagents cannot get.
- **Hermes CAN be focused.** A "fixed, not revisitable" spec constraint proved
  false under live testing on the same Herdr version. Design needed no change
  (the pane join was always generic); documentation did.
- **Both declared unknowns answered, both negative in the useful sense.**
  `interactive_ready` cannot detect Kimi's trust gate (reports `true` while
  stalled), so the standing spawn caveat stays. A pruned Hermes id raises no
  error at all — the pane opens and falls through to a new session.
- **Title writes overwrite** (John's ruling 2026-08-11), replacing the old
  skill's append-only rule. One row, one name; a correction should correct.
- Title endpoint chosen over a `psql` one-liner in the skill: the writer should
  match the reader, and `sm` is a pure HTTP client so it runs from any tailnet
  machine. Acknowledged as the more expensive choice.
- Rotation rule suspended by John for this one rotation; he ran the `sudo`
  restart, Claude ran the rest.

## Notes

- Session started 2026-08-10, ran through 2026-08-11.
- Suite 79 → 157 tests; ~55 mutants applied, watched fail, reverted.
- Token rotated across six live files; old token dead.
- Two silent-failure bugs found that a green suite could never have caught: the
  `/index-session` UUID guess (mtime over ten transcripts) and `grep` being
  shimmed to `ugrep --ignore-files`, which hid `.env.local` from a secret sweep.
- Saved to Claude memory: the `grep`/`ugrep` trap (cross-project, not
  session-minder specific).
