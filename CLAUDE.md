# session-minder

Single-user tool to track and access sessions across Claude Code, Hermes Agent, and Kimi Code.

<intent>
Objective: help a single user find, browse, and resume past sessions across Claude Code, Hermes Agent, and Kimi Code without needing to remember which tool or directory a session lived in.
Outcomes: user can list/search sessions across all three tools from one place; user can jump back into a specific past session quickly.
</intent>

<stack>
- runtime: Node.js 20+ with `tsx`
- framework: Fastify 4
- database: Postgres, schema `_sessionminder` on `vps8-core:5433`
- deploy: systemd unit on vps8, tailnet-only (see `deploy/session-minder.service`)
</stack>

<commands>

| Task | Command |
|------|---------|
| Dev | `npm run dev` |
| Test | `npm test` |
| Lint | — |
| Build | — (the service runs from source via `tsx`) |
| Pre-commit | `pre-commit run --all-files` |

</commands>

<gotchas>
**The Herdr test fake validates nothing that Herdr validates.** `test/herdr.test.ts`
stands up a real unix socket, but its responder accepts any request and returns whatever
the test says. Herdr does not. It enforces:

- agent names matching `^[a-z][a-z0-9_-]{0,31}$` — a space is rejected outright
- agent names **unique among live agents** — a second spawn reusing a name is rejected
- `agent.start` blocks until the agent is detected and ready (Hermes measured at ~3.1s),
  so a short client timeout aborts a spawn that would otherwise have succeeded

All three of those shipped to the live service during Phase 2.a and passed the full suite.
Each surfaced identically as `herdr_unreachable`, because `src/herdr.ts` then collapsed
socket-missing, timeout, and protocol rejection into one error type — so the reported cause
was misleading in every case. **Phase 2.b fixed the collapse** (`HerdrRejectedError` now
carries Herdr's own code and message; see `src/herdr.ts`), but the fake's blindness is
permanent. **Any change to what we send Herdr needs one live check against the running
server, not just a green suite.** Read the schema with `herdr api schema --json` rather
than the docs; they disagree.

**Herdr reports `agent_session` for Hermes panes sometimes — not never.** Phase 2.a
concluded "never" from two observations and the spec recorded it as a fixed constraint.
Live on 2026-08-11, same Herdr 0.7.5, two of four Hermes panes reported it
(`source: "herdr:hermes"`) and a live Hermes session **focused** cleanly through this
service. The pane join is generic, so nothing in the code cares which platform it is —
but do not write code, docs, or user-facing copy that asserts a per-platform rule here.
Whether a pane reports its session id appears to depend on how the agent was started, and
that is not something we control or can predict.

This is the second time a "confirmed live" Herdr fact has expired without a version bump.
Treat every observed Herdr behavior as true-on-the-day-observed, not as a constant.
</gotchas>

<wiring>
**The repo is not the installation.** A clean `git clone` gives you a service that starts
and captures nothing. Five things live outside this repo and are what actually make it
work. Verified 2026-08-11.

| Where | What it holds | Restore by |
|---|---|---|
| `.env.local` (repo root, mode 600, gitignored) | `DATABASE_URL`, `SESSION_MINDER_TOKEN`, `PORT`, `SESSION_MINDER_URL` | copy `.env.example`, fill in |
| `/etc/systemd/system/session-minder.service` | the unit | `sudo cp deploy/session-minder.service /etc/systemd/system/` then `daemon-reload`, `enable --now` |
| `~/.claude/settings.json` | Claude Code start/end hooks **and** an inline `SESSION_MINDER_TOKEN` | re-add hook entries pointing at `hooks/claude-code/` |
| `~/.hermes/shell-hooks-allowlist.json` + `~/.hermes/.env` + `~/.hermes/profiles/*/.env` | Hermes hook permission and the token, per profile | allowlist the two scripts in `hooks/hermes/`; set the token in each profile that captures |
| `~/.kimi-code/config.toml` | Kimi hooks | point at `hooks/kimi-code/` (reads the token from `.env.local` directly — no copy of its own) |
| `~/.claude/skills/index-session/SKILL.md` | the `/index-session` gesture — `PUT /api/sessions/title` with `$CLAUDE_CODE_SESSION_ID` | reads the token from `.env.local`; no copy of its own |

Plus the convenience alias in `~/.bashrc`:
```
alias sm='/snap/bin/node /home/john/dev/active/session-minder/node_modules/tsx/dist/cli.mjs /home/john/dev/active/session-minder/src/cli/sm.ts'
```
Direct node, not `npx` — outside the repo `npx` cannot see the local `tsx` and fetches its
own copy over the network (measured: 1.48s vs 0.58s). Same reason the unit file pins
`/snap/bin/node`.

**Token rotation touches six live files**, not one: `.env.local`, `~/.claude/settings.json`,
`~/.hermes/.env`, and `~/.hermes/profiles/{mccoy,the-beav,vulcan}/.env`. The systemd unit
holds no inline copy (it reads `EnvironmentFile`), and the Kimi hook reads `.env.local`.

**When searching for secrets on this machine, use `command grep`, not `grep`.** Claude Code
installs a `grep` shell function that routes to `ugrep --ignore-files`, which honors
`.gitignore` — so a plain recursive `grep` silently skips every gitignored file, which is
exactly where secrets live. This produced a wrong "every copy of the token" list on
2026-08-11 before it was caught.
</wiring>

<references>
Shared knowledge at ~/.claude/references/ — read on demand:
- anthropic-best-practices/ — prompting, skills, agents, MCP + URL registry
- contract-principles.md + architecture-structure-core.md — schema-as-contract, layer stack
- agent-teams/ — platform constraints, evaluation signals
</references>
