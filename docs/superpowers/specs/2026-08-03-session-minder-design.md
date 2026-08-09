# session-minder — Design Spec

Date: 2026-08-03
Updated: 2026-08-03 — Phase 1 shipped; Phase 2 split into 2.a (Herdr
integration) and 2.b (Dashboard) after the Herdr evaluation landed (see
"Herdr Integration").
Updated: 2026-08-08 — Herdr integrations installed; the 2.a spike ran and
resolved every blocking unknown (see "Spike results"). 2.a is unblocked for
implementation.
Updated: 2026-08-09 — Kimi Code integration installed and Kimi capture
live-verified; resume commands verified for all three platforms. Phase 2.a
now covers Claude Code, Hermes, and Kimi Code equally.
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
  context. **Mechanism resolved 2026-08-03: route through Herdr** (with
  platform-native resume commands as the degrade path — see "Herdr
  Integration").

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

## Architecture — Phases

**Phase 1 — Capture platform (data first). [SHIPPED 2026-08-03]** Postgres
schema + a thin web API with one ingest endpoint. Claude Code and Hermes hooks
fire on session start/end and POST metadata to it. This phase alone retires
the three Markdown files: every session, from every platform, lands in
Postgres automatically.

**Phase 2.a — Herdr integration layer.** The attach/resume evaluation landed
on Herdr (2026-08-03; see "Herdr Integration" below). Before the dashboard is
designed, build the thin server-side layer that makes attach/resume real:
verify hook coexistence hands-on, enrich capture with Herdr pane/workspace
references, and expose an attach contract the dashboard can call.
Prerequisite: John is adopting Herdr as a daily driver (replacing tmux) in
parallel — 2.a implementation starts once Herdr is under his fingers and
running on vps8 day-to-day.

**Phase 2.b — Dashboard.** A web UI (cards, search/filter, CRUD triage) on
top of the same Postgres table, now designed *against* the 2.a attach
contract: live-status badges and one-click attach/resume are first-class
features rather than "copy this command" placeholders. Kimi Code capture
support remains deferred to whenever Kimi Code is brought online.

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
  **Superseded as of v0.20** — use signed outbound webhooks instead; the
  shell hook remains the fallback if the webhook path disappoints. See
  "Hermes outbound webhooks" below.
- Kimi Code: confirmed available — `[[hooks]]` rules in `~/.kimi-code/config.toml`,
  `event = "SessionStart"` (matcher `startup`/`resume`) and `event =
  "SessionEnd"` (matcher `exit`), same JSON-stdin/exit-code shape as Claude
  Code and Hermes. Both are observation-only (fire-and-forget; script output
  never blocks the session), which matches this design's non-blocking
  requirement without extra work. Source: [Kimi Code docs — Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html).

**Hermes outbound webhooks (v0.20, preferred over a shell hook).** Hermes
Agent v0.20.0 (2026.8.3 — already installed on vps8 as of 2026-08-04) added
*signed outbound webhooks*: Hermes POSTs a signed JSON body directly to a
registered HTTP endpoint per event, with no shell script and no `curl`
wrapper in between. This is the better Hermes capture path — fewer moving
parts, and it fires server-side so it covers Hermes surfaces that never touch
a terminal (Telegram, cron). Source:
[Event Hooks | Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks),
[v0.20.0 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.3).

Config lives in `~/.hermes/config.yaml`:

```yaml
hooks:
  outbound:
    - name: session-minder
      url: http://vps8-core:PORT/api/hooks/hermes
      events: [on_session_start, on_session_end]
      secret_env: HERMES_OUTBOUND_WEBHOOK_SECRET
      timeout: 10
```

Delivered payload:

```json
{
  "hook_event_name": "on_session_end",
  "tool_name": null,
  "tool_input": null,
  "session_id": "sess_abc123",
  "cwd": "/home/user/project",
  "extra": { "completed": true, "interrupted": false, "model": "...", "platform": "cli" },
  "delivery_id": "3f2c9a...",
  "timestamp": "2026-07-22T14:00:00Z"
}
```

Headers: `X-Hermes-Event`, `X-Hermes-Delivery` (matches `delivery_id`), and
`X-Hermes-Signature-256: sha256=<hex>` — GitHub-style HMAC-SHA256 over the
**raw request body**, present only when `secret_env` is set.

*Adapter route, not the capture route.* The payload shape does not match
`POST /api/sessions/capture`, so Hermes gets its own endpoint
(`POST /api/hooks/hermes`) that verifies the signature and translates:

| Hermes field | session-minder column |
|---|---|
| `session_id` | `external_session_id` |
| `cwd` | `project_path` (often null for Hermes) |
| `hook_event_name` | `event` (`on_session_start` → `start`, `on_session_end` → `end`) |
| `extra.platform` | surface discriminator → `raw_metadata.hermes.surface` |
| `delivery_id` / `timestamp` | replay defense (below), not stored columns |

`host` and `message_count` have **no source in the payload**. Pin `host` per
endpoint in config (the webhook always originates from the Hermes server);
leave `message_count` null for Hermes unless we later subscribe to
`post_llm_call` to count turns — out of scope for Phase 2.

*Traps to respect when implementing:*

- **Raw body required.** Fastify parses JSON before the handler runs;
  verifying HMAC against re-serialized JSON silently fails. The route needs a
  raw-body capture or a custom content-type parser.
- **Never return 4xx on a transient failure.** Hermes retries once on
  connection errors and 5xx, and *never* on 4xx — a 4xx is permanent data loss
  for that session. Prefer 5xx (or 2xx-and-log) for anything recoverable.
- **No redirects.** A 3xx is treated as misconfiguration and strips the
  signature, so register the exact final tailnet URL with no proxy hop that
  redirects.
- **Always set `secret_env`.** Unsigned webhooks are permitted but flagged in
  `hermes hooks list`.
- **Replay defense is nearly free.** Deduplicate on `delivery_id` and reject a
  `timestamp` outside a ~5-minute tolerance. Our `ON CONFLICT DO NOTHING`
  start / upsert end already absorbs replays; the timestamp check is the
  cheap extra.
- **`matcher` is tool-scoped only** (a regex over tool names for
  `pre_tool_call`/`post_tool_call`). There is no startup-vs-resume matcher for
  session events — idempotent start is the answer for Hermes (see open
  question 5).
- **Best-effort delivery.** Events queue on a bounded queue and are posted by
  a background thread; backpressure drops events and failures are logged, not
  retried further. Same acceptable data-completeness gap the design already
  accepts for hooks.

**Non-blocking by design.** Hermes hooks are already non-blocking (errors
logged, never crash the agent). The Claude Code side matches that
deliberately: short `curl` timeout (~2s), fire-and-forget, swallow errors. A
capture failure must never be visible mid-session — worst case, a session
goes uncaptured and is noticed missing later. This is an acceptable data-
completeness gap, not a workflow interruption to guard against further.

## Herdr Integration (Phase 2.a)

Findings from the 2026-08-03 Herdr docs evaluation
([docs](https://herdr.dev/docs/), [session state](https://herdr.dev/docs/session-state/),
[agents](https://herdr.dev/docs/agents/), [socket API](https://herdr.dev/docs/socket-api/),
[integrations](https://herdr.dev/docs/integrations/),
[plugins](https://herdr.dev/docs/plugins/)), and the resulting design.

### Verdict: complementary, not a replacement

Herdr does **not** do what session-minder does. Its session state
(`session.json`) is *live/restore* state — it reconstructs the current
workspace (panes, tabs, cwds, running agents) after detach or server restart.
It keeps no catalog of past ended sessions, no titles/notes/curation, no
cross-time search. Structurally it can't replace session-minder:

- Herdr only sees terminal panes. Hermes-via-Telegram sessions never touch
  it; hook-driven capture covers every surface. The Hermes outbound webhook's
  `extra.platform` field (`cli` vs. other surfaces — see "Hermes outbound
  webhooks" above) is how we identify these pane-less sessions: a non-CLI
  Hermes row can never have a live Herdr pane, so the attach endpoint can
  route it straight to the **degrade** branch without a socket round-trip.
- It has no curation model — no counterpart to `status`, `noise_flag`,
  titles/notes, or the capture/curation split.

Herdr answers "what's running right now and how do I get back to it";
session-minder answers "what did I work on, and which of those deserves
resuming." **Decision: keep session-minder; use Herdr as the attach/resume
mechanism.**

### What Herdr provides (spike-confirmed 2026-08-08 against Herdr 0.7.5)

Everything below was doc-derived on 2026-08-03 and re-verified hands-on on
2026-08-08 except where marked *doc-only*. See "Spike results" under 2.a scope.

- **Socket API** at `~/.config/herdr/herdr.sock` (named sessions:
  `~/.config/herdr/sessions/<name>/herdr.sock`; overrides via
  `HERDR_SOCKET_PATH` / `HERDR_SESSION`). Newline-delimited JSON
  request/response (`id`, `method`, `params`). **Trap: `id` must be a JSON
  string.** An integer is rejected outright with
  `invalid request: invalid type: integer 1, expected a string` — the docs
  give the field name but not its type.
- **Native session ID exposure**: `agent.list`/`agent.get`/`pane.list`/
  `pane.get` expose a read-only `agent_session` object (kind + value) when
  Herdr has a stored native session reference — i.e. the same Claude Code
  UUID our `external_session_id` column holds. This is the join key between
  a `sessions` row and a live Herdr pane. **Confirmed live**: `pane.list`
  returned `{"source":"herdr:claude","agent":"claude","kind":"id","value":
  "<uuid>"}` for a pane whose `<uuid>` matched that session's
  `external_session_id` in `_sessionminder.sessions` exactly.
  Note `agent_session` is *absent* on panes whose agent started before the
  integration was installed — the attach endpoint must treat a missing
  `agent_session` as "not live", never as an error.
- **Control surface**: `pane.focus`/`workspace.focus`/`tab.focus`,
  `agent.attach` (CLI helpers), `pane run`/`agent start` to spawn a pane
  running a command in a chosen directory, `pane.send_input`,
  `events.subscribe` for a long-lived event stream.
- **Native agent resume**: Herdr itself restarts supported agent panes via
  integration-specific resume commands (e.g. `claude --resume <id>`).
  *(doc-only — not exercised in the spike.)*
- **Official integrations** for all three platforms, installed *alongside*
  existing hooks (append, not replace): Claude Code →
  `~/.claude/hooks/herdr-agent-state.sh` + `settings.json` entries; Kimi Code
  → appended `[[hooks]]` in `config.toml`; Hermes → plugin in
  `~/.hermes/plugins/herdr-agent-state/` enabled in `config.yaml`.
  **Append-not-replace confirmed for all three** — Claude Code and Hermes on
  2026-08-08, Kimi Code on 2026-08-09. All three self-report via
  `herdr integration status` (`claude: current (v7)`, `hermes: current (v3)`,
  `kimi: current (v5)`) — a cheap post-upgrade regression check.
- **Plugin system**: `herdr-plugin.toml` manifest, `[[events]]` subscriptions,
  any-language commands receiving `HERDR_PLUGIN_EVENT_JSON` — a possible
  later home for session-minder actions inside Herdr itself.

### 2.a scope

1. ~~**Spike (verify before building).**~~ **DONE 2026-08-08** — see "Spike
   results" below. All three questions answered; nothing found that changes
   the 2.a design.
2. **Capture enrichment.** When capture hooks run inside a Herdr pane, record
   Herdr references (session name, workspace/pane identity, socket path) into
   `raw_metadata.herdr`. No schema change — `raw_metadata` was reserved for
   exactly this. The spike settles the mechanism: **read the `HERDR_*`
   environment, do not call the socket.** Enrichment stays a pure env read
   inside an already-fire-and-forget hook, so it cannot add latency or a
   failure mode to capture.
3. **Attach contract.** A server-side endpoint (e.g.
   `POST /api/sessions/:id/attach`) that resolves a session row to an action:
   - **Live** — `external_session_id` matches an `agent_session` on the Herdr
     socket → focus/attach that pane.
   - **Ended** — spawn a new Herdr pane in the row's `project_path` running
     the platform-native resume command (`claude --resume <uuid>`, etc.).
   - **Degrade** — Herdr unreachable, session captured on another host, or no
     `project_path` to spawn into → return the platform-native resume command
     as copyable text (the dashboard's v1 behavior survives as the fallback).

**Resume commands (all three verified 2026-08-09 against the installed
binaries):** `claude --resume <id>`, `hermes --resume <id>`,
`kimi --session <id>`. The Herdr `agent.start` kind is `claude` / `hermes` /
`kimi` respectively — note it differs from the `platform` column value for two
of the three. The `external_session_id` is passed through verbatim in every
case; Kimi's stored session directories are literally named `session_<uuid>`,
so its prefix is part of the id, not a wrapper to strip.

### Spike results (2026-08-08, Herdr 0.7.5)

Run read-only from inside Herdr session `herdr-4up`, pane `w9`, with both
official integrations installed (`claude` v7, `hermes` v3).

**(a) Hook coexistence — safe, on both platforms.** The Claude installer
appended: `~/.claude/settings.json` retains session-minder's `SessionStart`
and `SessionEnd` entries and adds a *second* `SessionStart` entry
(`herdr-agent-state.sh session`, `timeout: 10`). Hermes cannot collide at all
— session-minder owns `hooks.on_session_start`/`on_session_end` (shell
commands) while Herdr rides the plugin system
(`plugins.enabled: [herdr-agent-state]`), two independent mechanisms.
Verified behaviorally, not just by inspection: four sessions across both
platforms captured into `_sessionminder.sessions` after the integration was
installed.

**(b) `HERDR_*` env vars are visible** to any process inside a pane, which is
everything enrichment needs: `HERDR_ENV=1`, `HERDR_SESSION`,
`HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`
(pane/tab IDs are workspace-scoped, e.g. `w9:p1`). Herdr's own hook script
uses exactly this env as its guard — `[ "$HERDR_ENV" = "1" ]`, then non-empty
socket path and pane ID, else exit 0 — which is the pattern our enrichment
should copy verbatim for the not-in-a-pane case.

**(c) `agent_session` carries our join key.** Confirmed byte-identical, and
the mechanism is visible in the installed script: Herdr's Claude hook reads
`session_id` straight out of the Claude Code hook payload and reports it to
the socket as `agent_session_id` — the *same* payload field session-minder's
capture hook stores as `external_session_id`. The two systems are not merely
compatible, they read the same source field. No normalization needed.

**Residual unknown.** No Hermes pane had a populated `agent_session` at spike
time. The plugin source does forward it (`_session_id(kwargs)` →
`params["agent_session_id"]`), so the path reads correct but is unobserved;
confirm opportunistically when a Hermes pane session runs. Not blocking —
non-CLI Hermes sessions were always routed to the degrade branch by design,
and an unpopulated CLI one degrades identically.

### Design guards

- **Keep the Herdr layer thin and behind session-minder's own API.** The
  dashboard only ever calls session-minder; session-minder translates to
  Herdr socket/CLI calls. Herdr is new (2026) and moving fast — if it's ever
  dropped, the attach endpoint degrades to printing native resume commands
  and the DB contract doesn't change.
- **No persistent event listener.** `events.subscribe` would mean a daemon;
  hooks already cover capture (standing resource-footprint rule: prefer
  event-driven scripts over daemons). Revisit only if a concrete need
  appears.
- **Server locality.** The Herdr server, session-minder, and the sessions
  being attached all live on vps8, so the socket is locally reachable.
  Sessions captured from other hosts (`host != vps8-core`) fall through to
  the degrade path.

## Dashboard (Phase 2.b)

- **Card grid**, one card per session: platform icon, title (or truncated
  `external_session_id` if untitled), project_path, started_at, duration,
  status badge.
- **Default view** excludes `noise_flag = true` and `status = pruned` —
  triage surfaces only what's worth a look.
- **Curation actions (CRUD)**: set title/note, mark `kept`/`pruned`,
  bulk-select + bulk-prune.
- **Search/filter**: by platform, project_path, date range, free-text over
  title/note.
- **Live-status badge**: rows whose `external_session_id` matches a live
  `agent_session` on the Herdr socket are badged "live" (resolved via the
  2.a layer at view time, not stored).
- **Attach/resume action**: one-click, backed by the 2.a attach contract —
  live sessions focus their Herdr pane, ended sessions spawn a resume pane
  in the right `project_path`, and the degrade path surfaces a copyable
  platform-native resume command (e.g. `claude --resume <uuid>`).

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
- Herdr layer (Phase 2.a): integration tests for the attach endpoint's three
  branches (live / ended / degrade), with the Herdr socket faked; the spike
  itself is manual verification against a real Herdr server on vps8.
- Dashboard (Phase 2.b): component-level tests for triage actions (status
  change, bulk-prune).

## Open Questions (deferred, not blocking Phase 1)

1. ~~Attach/resume mechanism.~~ **Resolved 2026-08-03** — routes through
   Herdr, with platform-native resume commands as the degrade path. Herdr
   cannot replace session-minder (live/restore state only; no history,
   curation, or non-terminal surfaces) but is the right attach mechanism.
   Full findings and 2.a design: "Herdr Integration" section above. John is
   adopting Herdr as his multiplexer (replacing tmux), which is what makes
   this the natural route.
2. ~~Kimi Code hook support.~~ **Fully resolved 2026-08-09** — no longer
   deferred. Capture is live-verified: `_sessionminder.sessions` holds a real
   `kimi_code` row with both a start and an end event
   (`session_5890019f-…`), which discharges Phase 1's one skipped step
   (Task 9, Step 5). The Herdr Kimi integration is installed
   (`kimi: current (v5)`) and appended cleanly — session-minder's two
   `[[hooks]]` blocks in `~/.kimi-code/config.toml` survive untouched, and
   Herdr's own blocks follow them under a `# >>> herdr kimi integration`
   marker. Kimi Code is now a first-class platform in Phase 2.a alongside
   Claude Code and Hermes.
3. **Noise thresholds.** Exact duration/message_count cutoffs for
   `noise_flag` to be tuned empirically once real Hermes capture data exists.
4. ~~**Herdr spike unknowns (Phase 2.a, step 1).**~~ **Resolved 2026-08-08**
   against Herdr 0.7.5 — hook coexistence, `HERDR_*` visibility, and the
   `agent_session` join key are all confirmed hands-on; see "Spike results"
   above. One residual, non-blocking: whether the Hermes integration
   populates `agent_session` for CLI-surface Hermes sessions (source reads
   correct, unobserved live). Herdr is young and fast-moving, so treat the
   spike as pinned to 0.7.5 — `herdr integration status` reporting anything
   other than `current` is the signal to re-verify.
5. **Exact resume-matcher syntax for Claude Code.** Kimi Code's
   `startup`/`resume` matcher split is confirmed; Claude Code's equivalent (if
   any) needs confirming during implementation so the "ignore resume, fire
   only on fresh start" rule can be applied consistently. If a platform has no
   such distinction, fall back to the idempotent `ON CONFLICT DO NOTHING`
   insert on every `SessionStart`-equivalent fire. **Hermes is resolved**: its
   outbound-webhook `matcher` is tool-scoped only (a regex over tool names for
   `pre_tool_call`/`post_tool_call`), so there is no startup-vs-resume
   distinction on session events — the idempotent-start fallback *is* the
   Hermes answer, by design rather than by omission.

## Non-Goals

- No multi-user support — single-user bearer-token auth only.
- No automatic LLM-generated summaries of session content in v1 — curation
  (titles/notes) is manual, by design (decoupled from capture).
- No public/internet-facing deployment — tailnet-only.
- No scanner/cron-based capture — hooks are event-driven, not polled.
- No pivot to Herdr as the system of record — Herdr is the attach/resume
  mechanism only, kept thin and behind session-minder's API so it can be
  swapped out without touching the DB contract.
- No Herdr plugin, and no persistent `events.subscribe` listener, in
  Phase 2 — both are possible later extensions, not current scope.
