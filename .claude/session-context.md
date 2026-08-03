# Session Context

## Current Focus
session-minder-brainstorm — run the brainstorm skill to flesh out the session-minder idea and work toward a prompt. session-minder is a single-user tool to track and access sessions across Claude Code, Hermes Agent, and Kimi Code.

## Honcho Context
No prior thread named "session-minder" exists in Honcho, but peer=john has substantial related history that should inform the brainstorm:

- **Existing infra**: Hermes has native `hermes sessions list` / `hermes --resume SESSION_ID`; a manually curated Hermes index at `_system/hermes-session-index.md`; a Claude Code `/index-session` skill writing to `~/idea-foundry/idea-foundry-vault/_system/claude-session-index.md` (title, UUID, date, note) with a `sessions` shell alias and `claude --resume <uuid>`; Kimi Code has its own index at `~/.kimi-code/skills/kimi-session-index.md`.
- **Stated preferences**: intentional session naming (memory-reliance was a pain point); selective/deliberate indexing, not auto-archiving everything; a canonical cross-surface session identity so work/memory transfers between Claude Code and Hermes; explicit concern about clutter and over-indexing.
- **Prior idea (unresolved)**: an automated session-splitting concept — AI detects topic divergence mid-session, spins off a new session with context, names/indexes it, verifies it's protected before abandoning the old thread.
- **Core problem framing**: work is discontinuous across multiple AI runtimes/VPSs/repos; native session systems are fragmented and session IDs are hard to remember; the goal is reliable return to the right thread after interruption.
- **Likely shape**: single-user, cross-surface (not pretending mechanics are identical), index-oriented (title/ID/date/workspace/agent/purpose), searchable/browsable, resume-oriented, human-in-the-loop for naming/indexing, file/Markdown-friendly.

## Key Decisions
- Postgres single source of truth (`_sessionminder` schema), replacing the three Markdown index files.
- Capture is fully automatic (hook-driven), decoupled from curation (dashboard triage happens later, in bulk).
- Capture wired through a thin bearer-token-authed API (not direct-to-Postgres hooks, not a scanner/cron poller).
- Two-phase build: Phase 1 = capture platform (schema + API + hooks, no UI); Phase 2 = dashboard.
- Confirmed all three platforms (Claude Code, Hermes, Kimi Code) support session-start/end shell hooks with a compatible JSON-stdin wire protocol.
- Start-event inserts are idempotent (`ON CONFLICT DO NOTHING`) to handle resume firing the same hook as fresh start.
- Attach/resume mechanism (tmux vs. Herdr vs. platform-native) deliberately deferred pending the Herdr evaluation.
- Hosting: tailnet-only on vps8, same pattern as proposaltracker/37pencils.
- Phase 1 tech stack: Fastify + TypeScript + postgres.js + Vitest (not full SvelteKit — no UI needed yet).

## Notes
- Session started: 2026-08-03
- Design spec: `docs/superpowers/specs/2026-08-03-session-minder-design.md`
- Phase 1 implementation plan: `docs/superpowers/plans/2026-08-03-session-minder-phase1-capture-platform.md`
- Git not yet initialized for this project — held off at John's request; init + first commit still pending.
- Model guidance given: Opus for planning, Sonnet for routine implementation from a clear spec (or the `opusplan` alias).

## Session Status
Completed: 2026-08-03
Servers cleaned: none (no MCP servers added this session)
