# Status

## Where are we?

session-minder is still in the design stage — nothing has been built yet, but
the full plan for the first build phase is written and ready to go.

The idea: right now, keeping track of past Claude Code, Hermes Agent, and
(eventually) Kimi Code sessions relies on manually-maintained Markdown files
in the vault, updated only when you remember to do it. session-minder is
meant to replace that with one automatic, always-up-to-date record in
Postgres, with a browsable dashboard on top later.

This session worked through a full brainstorm and landed on a design: every
session gets captured automatically the moment it starts and ends (via hooks
built into Claude Code, Hermes, and Kimi Code — no need to remember to do
anything), and stored in one Postgres table. Deciding what's actually worth
keeping, naming things, and cleaning out noise happens separately, later, in
a dashboard — not something you have to do in the moment.

Two things came out of this session as documents:
- A design spec (what we're building and why)
- A full implementation plan for Phase 1 — just the capture side (database +
  a small API + the hook scripts for each platform), no dashboard yet. It's
  broken into 10 small, buildable steps.

Project scaffolding (gitignore, env files, CLAUDE.md, etc.) is in place, but
this isn't a git repository yet — that's intentionally on hold.

## What's unresolved?

- **How you'll actually click into a session and pick up where you left
  off** (the "open/attach" feature) is deliberately not decided yet. It
  depends on how your evaluation of Herdr (a newer terminal tool built for
  running AI agents) turns out — if Herdr already solves this well, the plan
  is to lean on it rather than build something redundant.
- Kimi Code support is designed and hooked up in the plan, but won't be
  tested for real until you actually start using Kimi Code day to day.
- The exact thresholds for what counts as a "noise" session (e.g. a Hermes
  session that spun up briefly and did nothing) are a starting guess — will
  need tuning once real data comes in.
- Git isn't initialized for this project yet — you wanted to get situated
  first.

## What's next?

Sit down and start building Phase 1 (the capture platform — database, API,
and the hook scripts) using the plan document. When you're ready, decide
whether to have it built task-by-task with review checkpoints (recommended)
or all at once. The recommendation from this session was: use Opus for any
planning/design decisions, Sonnet for the actual step-by-step building, since
the plan is already detailed enough not to need heavy judgment calls during
execution.

Once Phase 1 is live and capturing real sessions for a bit, the dashboard
(Phase 2) is the natural next conversation.
