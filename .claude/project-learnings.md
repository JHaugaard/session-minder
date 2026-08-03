# Project Learnings

Persistent knowledge captured from sessions. This file accumulates useful discoveries, quirks, and decisions that should be remembered across sessions.

<!-- Entries added by /session-end -->

## 2026-08-03 — session-minder-brainstorm

- **Capture/curation decoupling (core architectural principle).** Capture is
  fully automatic and hook-driven — every session gets a Postgres row with no
  human-in-the-loop step. Curation (naming, tagging, deciding what's worth
  keeping, pruning) happens separately, later, in bulk via the dashboard.
  This resolved the tension between wanting full auto-capture and John's
  prior stated preference for selective/deliberate indexing to avoid
  clutter — new rows default to `status = unreviewed`, review happens
  whenever, not at creation time. Any future feature work should preserve
  this split rather than re-introducing an at-creation-time gate.

- **All three platforms support compatible session lifecycle hooks.**
  Confirmed via docs research: Claude Code (`SessionStart`/`Stop` in
  `.claude/settings.json`), Hermes Agent (`on_session_start`/`on_session_end`
  shell hooks in `~/.hermes/config.yaml`), and Kimi Code
  (`SessionStart`/`SessionEnd` in `~/.kimi-code/config.toml`, with a
  `startup`/`resume` matcher distinction Kimi exposes explicitly) all use the
  same JSON-payload-on-stdin, fire-and-forget, fail-open/non-blocking model.
  This is what made the hook-driven capture architecture viable across all
  three instead of needing per-platform bespoke integration.

- **Start-event capture must be idempotent.** `SessionStart`-type hooks fire
  on resume, not just fresh session creation (explicit in Kimi's
  `startup`/`resume` matcher; assumed true for Claude Code/Hermes pending
  confirmation during implementation). The capture endpoint's insert-on-start
  uses `INSERT ... ON CONFLICT (platform, external_session_id) DO NOTHING` so
  a resumed session never overwrites its original `started_at`.

