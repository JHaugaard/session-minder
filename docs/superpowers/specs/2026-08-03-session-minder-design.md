# session-minder — Design Spec

Date: 2026-08-03
Status: approved for planning

## Problem

Session history across Claude Code, Hermes Agent, and (eventually) Kimi Code is
fragmented. Each platform has its own native session mechanics and, today, its
own manually-maintained, append-only Markdown index
(`~/idea-foundry/idea-foundry-vault/_system/{claude,hermes,kimi}-session-index.md`),
kept up to date only when a human remembers to trigger it. Finding your way
back to a specific past session — especially in Hermes, where sessions spin up
for reasons other than deliberate user action (inactivity timeouts, cron jobs)
— depends on memory and manual discipline that has proven spotty.

## Goal

A single-user, self-hosted tool that:

- Automatically captures session metadata from every platform, with no
  human-in-the-loop step required for a session to be recorded.
- Stores that metadata in one Postgres source of truth, replacing the three
  fragmented Markdown index files.
- Surfaces sessions in a browsable/searchable dashboard (cards), with CRUD for
  a separate, deliberate curation pass (title, tag, keep/prune).
- Eventually supports one-click resume/attach into a session's terminal
  context (tmux, Herdr, or platform-native resume — mechanism deferred, see
  Open Questions).

## Design Principle: Capture vs. Curation Are Decoupled

The prior manual-trigger model required attentiveness at the moment a session
was created — easy to skip, especially for Hermes sessions the user didn't
initiate. This design splits the workflow in two:

- **Capture** is fully automatic (hook-driven, see below) and cheap. Every
  session gets a row. Nothing is lost to inattention.
- **Curation** (naming, tagging, deciding what's worth keeping) happens later,
  in bulk, via the dashboard. New rows default to `status = unreviewed`; nothing
  requires a decision at creation time.

This also solves the clutter risk of full auto-capture: sessions are
auto-tagged `noise_flag = true` (near-zero duration/message count — the
Hermes-timeout/cron case) and hidden from the default dashboard view rather
than requiring manual dismissal one at a time.

## Architecture — Two Phases

**Phase 1 — Capture platform (data first).** Postgres schema + a thin web API
with one ingest endpoint. Claude Code and Hermes hooks fire on session
start/end and POST metadata to it. This phase alone retires the three Markdown
files: every session, from every platform, lands in Postgres automatically.

**Phase 2 — Dashboard.** A web UI (cards, search/filter, CRUD triage) on top
of the same Postgres table. Kimi Code support and the click-to-attach feature
are deferred to this phase or later — Kimi's hook support needs verifying once
it's brought online, and attach mechanics depend on how the Herdr evaluation
lands (see Open Questions).

Hosting: tailnet-only, on vps8 alongside the user's other personal apps
(proposaltracker, 37pencils) — not a public Fly.io deployment. Single-user
bearer-token auth, no multi-tenant concerns.

## Data Model

Postgres schema `_sessionminder`, owned by role `_sessionminder_role` per the
project's standing database-conventions rule (see
`~/.claude/rules/database-conventions.md` — apply namespace/ownership rules at
implementation time, not repeated here since they're not session-minder-specific).

Single table:

### `sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | generated |
| `platform` | text | `claude_code` \| `hermes` \| `kimi_code` |
| `external_session_id` | text | the platform's own session ID/UUID |
| `host` | text | machine the session ran on (e.g. `vps8-core`, `mbp`) |
| `project_path` | text, nullable | cwd/repo path, if applicable (often absent for Hermes) |
| `started_at` | timestamptz | from the start hook |
| `ended_at` | timestamptz, nullable | from the end hook; null = still open or no end event ever arrived |
| `message_count` | int, nullable | from end-hook payload, when available |
| `noise_flag` | bool, default false | auto-set from duration/message_count thresholds |
| `title` | text, nullable | human-curated |
| `note` | text, nullable | human-curated free text |
| `status` | text, default `unreviewed` | `unreviewed` \| `kept` \| `pruned` |
| `raw_metadata` | jsonb | anything else the hook sends; kept for flexibility |
| `created_at` / `updated_at` | timestamptz | row bookkeeping |

Unique constraint on `(platform, external_session_id)`. The start hook
inserts; the end hook upserts the same row (fills `ended_at`, `message_count`,
recomputes `noise_flag`).

Noise threshold (exact values to be tuned during implementation): a session
with very short duration and/or very low message count is auto-flagged
`noise_flag = true` — this is the primary defense against Hermes
inactivity-timeout/cron-spawned session clutter.

## Capture Pipeline

**API.** One route, `POST /api/sessions/capture`, bearer-token auth (same
pattern as the project's other tailnet apps). Payload:

```json
{
  "platform": "claude_code",
  "external_session_id": "...",
  "event": "start" | "end",
  "host": "mbp",
  "project_path": "/home/john/dev/active/session-minder",
  "message_count": 12
}
```

- `event: start` → `INSERT ... ON CONFLICT (platform, external_session_id) DO
  NOTHING`. Idempotent by design: `SessionStart`-type hooks fire on both fresh
  sessions and resumed ones (see matcher note below), and a resume must never
  overwrite the original `started_at`.
- `event: end` → update the matching row (`ended_at`, `message_count`,
  recompute `noise_flag`).

**Resume vs. fresh-start matchers.** All three platforms distinguish a fresh
session start from a resumed one at the hook-declaration level (Kimi Code's
`SessionStart` takes a `matcher` of `startup` or `resume`; Claude Code and
Hermes are expected to expose an equivalent distinction — confirm exact
matcher syntax per platform during implementation). The capture hook only
needs to fire — and only needs to matter — on `startup`; a `resume` match can
either be ignored entirely or wired to the same idempotent `event: start` call
as a harmless no-op. Either is safe given the `ON CONFLICT DO NOTHING` semantics
above; prefer ignoring resume matches to keep hook scripts simpler.

**Hook scripts.** One small shell script per platform per event, reading the
hook's JSON-on-stdin payload and re-POSTing the relevant fields via `curl`.

- Claude Code: `SessionStart` and `Stop` hooks in `.claude/settings.json`.
- Hermes: `on_session_start` and `on_session_end` shell hooks in
  `~/.hermes/config.yaml` (confirmed available — Hermes shell hooks use a
  JSON stdin/stdout wire protocol compatible with the Claude Code hook shape;
  see [Event Hooks | Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)).
- Kimi Code: confirmed available — `[[hooks]]` rules in `~/.kimi-code/config.toml`,
  `event = "SessionStart"` (matcher `startup`/`resume`) and `event =
  "SessionEnd"` (matcher `exit`), same JSON-stdin/exit-code shape as Claude
  Code and Hermes. Both are observation-only (fire-and-forget; script output
  never blocks the session), which matches this design's non-blocking
  requirement without extra work. Source: [Kimi Code docs — Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html).

**Non-blocking by design.** Hermes hooks are already non-blocking (errors
logged, never crash the agent). The Claude Code side matches that
deliberately: short `curl` timeout (~2s), fire-and-forget, swallow errors. A
capture failure must never be visible mid-session — worst case, a session
goes uncaptured and is noticed missing later. This is an acceptable data-
completeness gap, not a workflow interruption to guard against further.

## Dashboard (Phase 2)

- **Card grid**, one card per session: platform icon, title (or truncated
  `external_session_id` if untitled), project_path, started_at, duration,
  status badge.
- **Default view** excludes `noise_flag = true` and `status = pruned` —
  triage surfaces only what's worth a look.
- **Curation actions (CRUD)**: set title/note, mark `kept`/`pruned`,
  bulk-select + bulk-prune.
- **Search/filter**: by platform, project_path, date range, free-text over
  title/note.
- **Attach/resume action**: v1 is "copy resume command" (e.g.
  `claude --resume <uuid>`), not live click-to-attach. The real one-click
  mechanism is deferred — see Open Questions.

## Error Handling

- Hook → API failures are silent to the user (fire-and-forget). No v1
  mechanism to detect/backfill missed captures; acceptable gap for now.
- API: standard 401 on bad/missing bearer token, 400 on malformed payload.
  The unique constraint on `(platform, external_session_id)` makes duplicate
  rows structurally impossible.
- Dashboard: standard CRUD error handling (inline/toast on failed save);
  nothing platform-specific.

## Testing

- API: integration tests on the capture endpoint — insert-on-start,
  update-on-end, noise_flag threshold logic, auth rejection.
- Hook scripts: manual verification against a live Claude Code and Hermes
  session. Thin enough that heavy automated coverage isn't warranted.
- Dashboard (Phase 2): component-level tests for triage actions (status
  change, bulk-prune).

## Open Questions (deferred, not blocking Phase 1)

1. **Attach/resume mechanism.** Whether click-to-attach routes through Herdr
   (if the evaluation lands there), falls back to plain `tmux`/platform-native
   resume, or supports both. Herdr is a Rust-based, tmux-like multiplexer
   built for AI coding agents — panes host agents, tracks per-pane state
   (working/idle/blocked), sessions persist as local JSON. If it turns out to
   already solve session tracking/attach at the terminal level, the plan may
   refocus toward using Herdr directly rather than building an attach
   mechanism in session-minder. (See
   [herdr — Terminal Trove](https://terminaltrove.com/herdr/),
   [Compare Herdr](https://herdr.dev/compare/).)
2. ~~Kimi Code hook support.~~ **Resolved** — confirmed available
   (`SessionStart`/`SessionEnd` in `~/.kimi-code/config.toml`, same
   JSON-stdin/exit-code model as Claude Code and Hermes). Remaining work is
   implementation only, deferred to when Kimi Code is actually brought online
   for project use — expected to resemble Claude Code (pinned-repo,
   intentional sessions) given its shared lineage.
3. **Noise thresholds.** Exact duration/message_count cutoffs for
   `noise_flag` to be tuned empirically once real Hermes capture data exists.
4. **Exact resume-matcher syntax for Claude Code and Hermes.** Kimi Code's
   `startup`/`resume` matcher split is confirmed; Claude Code's and Hermes's
   equivalent (if any) needs confirming during implementation so the "ignore
   resume, fire only on fresh start" rule can be applied consistently. If a
   platform has no such distinction, fall back to the idempotent
   `ON CONFLICT DO NOTHING` insert on every `SessionStart`-equivalent fire.

## Non-Goals

- No multi-user support — single-user bearer-token auth only.
- No automatic LLM-generated summaries of session content in v1 — curation
  (titles/notes) is manual, by design (decoupled from capture).
- No public/internet-facing deployment — tailnet-only.
- No scanner/cron-based capture — hooks are event-driven, not polled.
