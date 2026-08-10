# Phase 2.b opening prompt

Paste into a fresh session in `~/dev/active/session-minder`.

---

This is a design session for session-minder Phase 2.b — the dashboard. Design only:
brainstorm with me, converge on a shape I ratify, and stop. No implementation plan
until I approve the design, and no code in this session. Building happens in a
separate session against the plan.

Start with superpowers:brainstorming. Ask me your questions before proposing any
design — several of the questions below are genuinely undecided, and I want your
thinking to sharpen mine, not assumptions baked in early.

<context>
Phase 2.a shipped the attach layer: POST /api/sessions/:id/attach either focuses a
live pane, spawns a resumed one, or degrades to a copyable manual command. Degraded
returns 200 because it is a valid answer, not a failure. The dashboard is a client
of that endpoint and must not know anything about Herdr, the multiplexer underneath.

Read before brainstorming — current state and the contract live here, and I want
the exact response shapes taken from source so they can't drift:
- @.docs/status.md — where the project stands
- @.superpowers/sdd/2026-08-08-session-minder-phase2a-herdr-integration/progress.md
  — what actually happened in 2.a, including the live-verification ledger
- docs/superpowers/specs/ — the original spec
- @src/routes/attach.ts, @src/attach.ts, @src/herdr.ts — the attach contract
</context>

<constraints>
All confirmed by live observation in 2.a, not inference. Treat as fixed inputs:
- Hermes sessions can never be focused, only spawned — Herdr reports no session id
  for Hermes panes, so attaching to a live Hermes session degrades. Claude and Kimi
  are not affected. The dashboard must not offer what the platform can't deliver.
- A spawned pane can land on an interactive prompt instead of a ready session
  (Kimi stopped at a "Trust this folder?" gate). Spawned ≠ usable.
- Hermes prunes its own history, so some recorded sessions can't be resumed at all.
- Every Herdr failure currently surfaces as one generic "herdr_unreachable"
  regardless of cause. That conflation produced three misleading diagnoses in 2.a
  and cost a day. Splitting that error type is likely the first 2.b work item,
  before dashboard UI — otherwise the dashboard can only show a useless string.
  Weigh it as part of the design.
- Recorded dependency: Honcho curation should read from session-minder's table
  rather than being triggered by session-end.
</constraints>

<open-questions>
Undecided — bring analysis, not defaults:
- Is this for browsing history or resuming work? The two imply different designs,
  and I haven't chosen.
- What is the smallest version I would actually use daily?
- Where does it run, and does it need auth beyond the existing bearer token?
- What happens to sessions auto-flagged as noise (currently 18 of 50) — hidden,
  dimmed, filtered?
Do not pre-pick a stack for the dashboard — that is a live design question.
</open-questions>

<for-the-eventual-plan>
Carry this process rule into the plan you write after I ratify the design (not
before): in 2.a the plan wrote test code verbatim, and those tests passed while the
code was wrong — eight wrong-behavior mutants survived, and all three bugs that
reached the deployed service passed the full suite. The 2.b plan must state, per
test, the rule it pins and the specific mutant that must die, and require the
implementer to prove that mutant actually fails. No test bodies to transcribe.
</for-the-eventual-plan>

Done well: we end this session with a ratified dashboard design and a written
implementation plan that honors the constraints and the test rule above. If
anything in the repo contradicts what I've said here, or something you need is
unavailable, surface it rather than working around it.
