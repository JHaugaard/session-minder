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
Each surfaced identically as `herdr_unreachable`, because `src/herdr.ts` collapses socket-
missing, timeout, and protocol rejection into one error type — so the reported cause was
misleading in every case. **Any change to what we send Herdr needs one live check against
the running server, not just a green suite.** Read the schema with `herdr api schema --json`
rather than the docs; they disagree.

Hermes panes never report `agent_session`, so a live Hermes session can't be recognised and
always takes the spawn branch. Claude and Kimi do report it.
</gotchas>

<references>
Shared knowledge at ~/.claude/references/ — read on demand:
- anthropic-best-practices/ — prompting, skills, agents, MCP + URL registry
- contract-principles.md + architecture-structure-core.md — schema-as-contract, layer stack
- agent-teams/ — platform constraints, evaluation signals
</references>
