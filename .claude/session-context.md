# Session Context

## Current Focus
**phase-2b-plan** — the Phase 2.b design/planning session for the session-minder
dashboard. Entry point: `.docs/phase2b-prompt.md` (pointed to by `.docs/status.md`).

Ratified session shape (two-gate): brainstorm/design → John ratifies → write the
implementation plan → HARD STOP → build happens in a separate session. No code this
session.

## Honcho Context (peer=john)

**Binding constraints from Phase 2.a (settled, not up for re-litigation):**
- The dashboard is a client of the deployed `POST /api/sessions/:id/attach` contract
  (`focused` / `spawned` / `degraded`; `degraded` is a 200 with a manual recovery
  path, not an error). It should not know Herdr internals.
- Hermes is spawn-only: Herdr never reports `agent_session` for Hermes panes, so an
  existing Hermes session can never be recognised and focused. The UI must not offer
  a focus action Hermes can't perform. Claude and Kimi are unaffected.
- `spawned` ≠ usable — a spawned pane can stop at an interactive gate (observed:
  Kimi's "Trust this folder?" prompt). The dashboard needs an honest treatment of
  that intermediate state.
- First 2.b item: split `HerdrUnreachableError` — it conflates "Herdr not running"
  with "Herdr refused the request," which made all three Phase 2.a live defects
  report a misleading cause.
- Process lesson (binding for the plan): eleven real defects passed a green suite in
  2.a; all were found by mutation testing or live verification, none by reading code.

**Open design questions the session exists to decide (ask before proposing):**
1. What each session row/card shows (identity, platform, project, recency, state,
   attach affordance).
2. Which actions are offered per platform and state (focus vs spawn vs manual
   recovery; no false focus for Hermes).
3. How an interactive spawn gate is represented.
4. How stale/pruned/non-resumable sessions appear (some platforms prune history).
5. Whether a readiness/state model beyond the three attach outcomes is needed.
6. The error taxonomy and user-facing treatment after the Herdr error split.
- The dashboard stack is deliberately undecided — do not pre-pick it.

**Rules for how this session runs:**
- Brainstorm first; ask questions before proposing solutions.
- Plan only after John ratifies the design; build deferred to a separate session.
- The plan states, per test, the rule pinned and the specific mutant/wrong
  implementation that must fail — it does not hand over test bodies.
- Live verification matters for anything crossing the Herdr boundary; sudo stays
  hard-gated; one retry max on a failed live spawn; show diagnosis before any code
  change from a live finding.

## Last session curation (honcho-memory)
2026-08-10 prep session wrote 1 item as peer=john: #203, John's prompt-authoring rule
— a handoff prompt pre-decides nothing the session exists to decide and inlines
nothing that lives in source; open questions carry verbatim and the reader is told to
ask before proposing. (#200–202 cover the 2.a process finding, the Hermes
spawn-only constraint, and the provisional stop-gate pattern.)

## Key Decisions
- **"Resuming work, solely"** — 2.b dashboard became the `sm` resume-only terminal
  picker; browse/curation/web UI cut, `title`/`note` columns kept (title read-only).
- On-demand picker in a Herdr pane; noise hidden behind `sm --all`; zero new deps
  with the pick step behind a seam (fzf deferred, reversible).
- `/index-session` retarget (markdown indexes → DB title write) recorded as the
  post-2.b follow-up and the trigger for retiring the three markdown index files.
- Standing completion gate ratified into the spec: any Herdr-boundary change needs
  one live check before "done".
- Spec ratified & committed (a6b0352); plan written under the no-test-bodies
  rule+mutant contract & committed (551a38f). Build deferred to its own session.

## Session Status
Completed: 2026-08-10
Servers cleaned: none — no MCP servers were added this session
Honcho curation: COMPLETE — 2 items written as peer=john (#204 resume-solely scope
  ruling superseding the 2.b dashboard section; #205 /index-session retarget).
  Rejected: the live-gate ratification (already in workflow-rules/CLAUDE.md/#200),
  the fzf seam choice, #200/#201 re-applications, all repo-recorded design output.

## Notes
- Session started: 2026-08-10
- Housekeeping still open from prior session: delete synthetic row
  `phase2a-verify-20260809-133128`; rotate `SESSION_MINDER_TOKEN` (mbp/mini need the
  new value); keep the 2.a SDD workspace until the 2.b brief is written; commit the
  boundary-verification rule in idea-foundry-ops; `.docs/` is untracked — the prompt
  file is one `git clean` away from vanishing.
