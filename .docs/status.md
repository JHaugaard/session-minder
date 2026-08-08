# Status

_Last verified against the running system 2026-08-07._

## Where are we?

**Phase 1 is built, deployed, and capturing.** (This section previously said
"still in the design stage — nothing has been built yet"; that was written
before the build session and went stale the same day.)

The idea: keeping track of past Claude Code, Hermes Agent, and eventually Kimi
Code sessions used to rely on manually-maintained Markdown files in the vault,
updated only when you remembered to. session-minder replaces that with one
automatic, always-up-to-date record in Postgres, with a browsable dashboard on
top later.

What's actually live right now:

- **Database** — schema `_sessionminder` on `vps8-core:5433`, one `sessions`
  table, owned by `_sessionminder_role`.
- **API** — Fastify service, bearer-token auth, `POST /api/sessions/capture`
  handling both start and end events. `healthz` returns `{"ok":true}` on the
  tailnet and is unreachable publicly, as intended.
- **Deployment** — systemd unit on vps8, tailnet-only, currently **active**.
- **Hooks** — Claude Code's `SessionStart`/`SessionEnd` are registered in
  `~/.claude/settings.json` and firing. Hermes and Kimi Code hook scripts are
  written and committed.
- **Real data** — 33 sessions captured since 2026-08-03, 12 of them
  auto-flagged as noise.

The repository **is** initialized (12 commits through `e65aa7c`). 61 of the
plan's 62 steps are checked off.

## What's unresolved?

- ~~**How you'll actually click into a session and resume it**~~ — no longer
  blocked. The mechanism was resolved 2026-08-03 (route through Herdr, with
  platform-native resume as the degrade path), and the hold was "until the
  Herdr standup is complete." **That hold lifted 2026-08-08**: both official
  Herdr integrations are installed (`claude` v7, `hermes` v3) and the Phase
  2.a spike ran clean — session-minder's hooks survived the install, the
  `HERDR_*` pane env is readable, and Herdr's `agent_session` value is
  byte-identical to our `external_session_id`. Full findings in the spec's
  "Spike results". What remains for 2.a is implementation: capture
  enrichment into `raw_metadata.herdr`, then the attach endpoint.
- **Kimi Code verification** is the one unchecked plan step (Task 9, Step 5),
  deliberately deferred until Kimi Code is brought online for real project use.
  The scripts are written and script-level verified; only the live end-to-end
  check is outstanding.
- **Noise thresholds** (<60s duration, <3 messages) are still the original
  conservative guess. There's now real data to tune against: 12 of 33 sessions
  flagged. Worth a look before the dashboard makes them visible.
- ~~**Uncommitted spec changes**~~ — resolved 2026-08-08; the Phase 2.a /
  Herdr integration design and the spike results are committed.
- The three old Markdown index files in the vault
  (`_system/{claude,hermes,kimi}-session-index.md`) are still untouched;
  retiring them is a Phase 2-or-later decision.

## Incoming dependency (noted 2026-08-07)

The `honcho-memory` subagent needs a reliable trigger for curating sessions into
Honcho. A `SessionEnd` hook was considered and **rejected** — that event is
already bound to session-minder, and a curation hook would re-couple exactly what
this project's "Capture vs. Curation Are Decoupled" principle separates.

The agreed shape instead: **Honcho curation becomes a consumer of
`_sessionminder.sessions`** — either a dashboard action on a session marked
`kept`, or a sweep over `status = 'unreviewed' AND NOT noise_flag`. This reuses
the existing noise gate rather than rebuilding one. Worth folding into the
Phase 2 dashboard scope when that conversation opens.

## What's next?

**Phase 2.a — the Herdr attach layer — is the next build**, and it is no
longer gated (see above). Two steps, both small and both already designed in
the spec: enrich capture with the `HERDR_*` pane identity, then add the
attach endpoint with its live / ended / degrade branches. 2.b (the dashboard)
follows, designed against that contract rather than around a "copy this
command" placeholder.

Still cheap and still worth doing alongside: tune the noise thresholds
against the data that's now accumulating.
