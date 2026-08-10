# Status

_Last updated 2026-08-10, end of the Phase 2.b design/planning session._

## Where are we?

**Phase 2.b is fully designed and fully planned, but not built.** The design
session ran today exactly per the two-gate shape: brainstorm, ratify section by
section, spec, then plan — with the build deliberately left for its own session.

The big ruling that shaped everything: **the dashboard became a picker.** You
decided 2.b is for resuming work, solely — not browsing, not curation. What got
designed is `sm`: a small command you run in any Herdr pane. It prints your
~15 most recent resumable sessions (noise hidden behind `sm --all`), you type a
number, and it jumps you to the live pane or spawns a freshly resumed one — or
hands you the exact command to paste when that's the honest best. Web UI, card
grid, and curation from the old spec section are out; the `title`/`note`
columns stay in the table, with `title` shown by the picker whenever something
sets it.

Two documents carry all of it, both committed:

- Spec: `docs/superpowers/specs/2026-08-10-session-minder-phase2b-picker-design.md`
  (your rulings and why, the row layout, the honest outcome messages, the
  testing contract)
- Plan: `docs/superpowers/plans/2026-08-10-session-minder-phase2b-picker.md`
  (8 tasks; per your post-2.a rule it contains **no test bodies** — each test
  is a stated rule plus the specific wrong implementation that must fail, and
  the implementer has to prove the kill)

Phase 2.a remains deployed and live on vps8; nothing running changed today.

## What's unresolved?

- **The build itself** — every task in the plan, including the first work item
  (splitting the misleading "Herdr unreachable" error into "Herdr is down" vs
  "Herdr refused, and here's its message").
- **Two questions only live testing can answer**, already slotted in the plan:
  what Herdr reports when a spawned agent stalls at an interactive gate (Kimi's
  trust prompt), and what happens when you resume a Hermes session Hermes has
  already pruned.
- **Housekeeping still owed (your authority):** delete the synthetic test row
  `phase2a-verify-20260809-133128` (it will show up in `sm` otherwise), rotate
  `SESSION_MINDER_TOKEN`, commit the boundary-verification rule sitting
  uncommitted in idea-foundry-ops, and — once the picker exists — add the `sm`
  alias to your `.bashrc`.
- **Follow-ups the design created, not part of the build:** retarget your
  existing `/index-session` skill to write session titles into the database
  instead of the three old markdown index files (that's also the natural
  moment to retire those files), and the Honcho-curation sweep that reads from
  the sessions table stays parked. Noise thresholds are still the original
  guess; `sm --all` will be your window for judging them.

## What's next?

Open a fresh session in this directory and start the build: point it at
`docs/superpowers/plans/2026-08-10-session-minder-phase2b-picker.md`. The
plan's header already tells the worker to use subagent-driven development
(fresh subagent per task, review between tasks — the 2.a method). Task 8 ends
with live verification through the real Herdr on vps8 and needs your sudo for
one service restart.
