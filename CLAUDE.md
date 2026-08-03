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

<references>
Shared knowledge at ~/.claude/references/ — read on demand:
- anthropic-best-practices/ — prompting, skills, agents, MCP + URL registry
- contract-principles.md + architecture-structure-core.md — schema-as-contract, layer stack
- agent-teams/ — platform constraints, evaluation signals
</references>
