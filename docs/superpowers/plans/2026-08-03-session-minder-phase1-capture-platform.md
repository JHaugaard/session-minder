# session-minder Phase 1: Capture Platform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Execution record (completed 2026-08-03)

All ten tasks executed and committed; `74944ac..8c0e396` is on `origin/main`. Steps are ticked below,
each annotated where reality diverged from the text. Conventions:

- `- [x]` with no note — done exactly as written.
- `↳ DEVIATION:` — done differently, and why. Every deviation was ruled on by the human before it was applied.
- `↳ DONE BY JOHN:` — executed by the human (sudo, superuser psql, or a live-daemon restart).
- `↳ SKIPPED:` — not done, and why. Exactly one step (Task 9, Step 5).

**Two places this plan was factually wrong**, both caught at implementation time: Task 8's Hermes YAML
schema, and Task 10's `ExecStart` (both npx forms resolve Node to v18.19.1 under systemd). See those steps.

**A pattern worth carrying into Phase 2:** every task's review found the plan's specified tests asserted
that *something happened* rather than pinning the behavior the spec singles out. `ON CONFLICT DO NOTHING`
and the platform allowlist could both be deleted with the plan's tests still green. Four extra commits
exist solely to close that gap.

Full run detail — reviews, fix rounds, adjudications — is in the gitignored SDD ledger at
`.superpowers/sdd/2026-08-03-session-minder-phase1-capture-platform/progress.md`.

---

**Goal:** Stand up the automatic, hook-driven capture pipeline (Postgres schema + ingest API + per-platform hook scripts) that replaces the three manual Markdown session indexes with one source of truth — no dashboard yet.

**Architecture:** A small Fastify + TypeScript service exposes one bearer-token-authed endpoint, `POST /api/sessions/capture`. Claude Code, Hermes, and Kimi Code each get a pair of thin shell hook scripts (session-start, session-end) that read the platform's own JSON-on-stdin hook payload and re-POST the relevant fields to that endpoint. The service is the only thing that touches Postgres, per the project's ownership convention. No UI in this phase — the deliverable is verified via `curl` and automated tests, not a browser.

**Tech Stack:** Node.js 20+, TypeScript, Fastify, `postgres` (postgres.js) driver, Vitest for tests, `tsx` for local dev. Deployed as a systemd service on vps8, bound directly to the vps8 tailnet IP — no reverse-proxy layer; hook scripts call `http://vps8-core:3000` straight over the tailnet — not exposed publicly.

## Global Constraints

- Single-user bearer-token auth only — no multi-user/session-cookie auth (spec: Non-Goals).
- Tailnet-only hosting on vps8 — no public/internet-facing deployment (spec: Non-Goals, Architecture).
- Capture is event-driven via hooks only — no polling/scanner/cron-based capture (spec: Non-Goals).
- Hook → API calls are fire-and-forget and non-blocking: short timeout (~2s), errors swallowed, never visible mid-session (spec: Capture Pipeline).
- `event: start` inserts are idempotent (`ON CONFLICT (platform, external_session_id) DO NOTHING`) — resumed sessions must never overwrite the original `started_at` (spec: Capture Pipeline, resolved 2026-08-03).
- Postgres schema `_sessionminder`, owned by role `_sessionminder_role` — the API service is the only component that connects to Postgres directly (spec: Data Model; `~/.claude/rules/database-conventions.md`).
- `platform` is one of exactly `claude_code`, `hermes`, `kimi_code` (spec: Data Model).
- Claude Code hooks are registered **user-level** (`~/.claude/settings.json`, on every machine Claude Code runs on) and use the `SessionEnd` event, not `Stop` — project-level hooks would capture only this repo's own sessions, and `Stop` fires after every assistant response, not at session end.
- Noise detection is duration-driven: no platform's end-hook payload reliably carries a message count, so a null `message_count` must never veto `noise_flag` (spec: "very short duration and/or very low message count").

---

## Task 1: Postgres role, schema, and table

**Files:**
- Create: `db/01-role-and-schema.sql`
- Create: `db/02-tables.sql`

**Interfaces:**
- Produces: table `_sessionminder.sessions` with columns exactly as listed below — every later task's SQL and TypeScript types depend on this shape.

- [x] **Step 1: Generate a role password**  
      ↳ DEVIATION: used `openssl rand -hex 32`, not `base64 24` — base64 can emit `/`, which breaks the `postgresql://` URL.

Run: `openssl rand -base64 24`

Save the output somewhere safe (e.g. a password manager) — it goes into `DATABASE_URL` in Task 2 and is substituted into the SQL below. Do not commit it.

- [x] **Step 2: Write `db/01-role-and-schema.sql`**

```sql
-- db/01-role-and-schema.sql
-- Run as the postgres superuser. Split from 02-tables.sql so the table file
-- can be applied connected AS _sessionminder_role — ownership follows the
-- connecting role (see ~/.claude/rules/database-conventions.md).

CREATE ROLE _sessionminder_role LOGIN PASSWORD 'REPLACE_WITH_GENERATED_PASSWORD';
CREATE SCHEMA IF NOT EXISTS _sessionminder AUTHORIZATION _sessionminder_role;
```

- [x] **Step 3: Write `db/02-tables.sql`**  
      ↳ Later amended (commit 3d861e3) with a comment documenting the `started_at = ended_at` missed-start invariant.

```sql
-- db/02-tables.sql
-- Run connected AS _sessionminder_role, NEVER as postgres. A table created
-- by the superuser is owned by postgres, and every future migration run as
-- the project role then fails with "must be owner of table" — the exact
-- _foundry trap from 2026-07 (see ~/.claude/rules/database-conventions.md).

CREATE TABLE _sessionminder.sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform            text NOT NULL CHECK (platform IN ('claude_code', 'hermes', 'kimi_code')),
    external_session_id text NOT NULL,
    host                text NOT NULL,
    project_path        text,
    started_at          timestamptz NOT NULL,
    ended_at            timestamptz,
    message_count       integer,
    noise_flag          boolean NOT NULL DEFAULT false,
    title               text,
    note                text,
    status              text NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed', 'kept', 'pruned')),
    raw_metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, external_session_id)
);

CREATE OR REPLACE FUNCTION _sessionminder.set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_set_updated_at
    BEFORE UPDATE ON _sessionminder.sessions
    FOR EACH ROW EXECUTE FUNCTION _sessionminder.set_updated_at();
```

- [x] **Step 4: pg_hba grant for the new role**  
      ↳ DONE BY JOHN (sudo).

Tailnet access to Postgres is network-open but per-role-authed (`~/.claude/rules/infrastructure.md`): the new role needs its own `pg_hba.conf` entry before it can connect at all. The API runs on vps8 and reaches Postgres at `vps8-core:5433`, so the connection originates from vps8's own tailnet IP:

```
host  postgres  _sessionminder_role  100.118.195.63/32  scram-sha-256
```

Add that line to `pg_hba.conf`, then `sudo systemctl reload postgresql` (reload, not restart). Without it, Step 5's second command fails with `no pg_hba.conf entry`.

- [x] **Step 5: Apply — two invocations, two roles**  
      ↳ DONE BY JOHN (superuser). The first `CREATE ROLE` never landed — role query returned 0 rows — and was re-run via `sudo -u postgres` with `ALTER ROLE`.

Substitute the generated password into `REPLACE_WITH_GENERATED_PASSWORD` in the role file and the connection string below, then:

```bash
# 1. Role + schema, as the superuser:
psql "postgresql://postgres@vps8-core:5433/postgres" -f db/01-role-and-schema.sql

# 2. Table + trigger, connected AS the project role — never as postgres:
psql "postgresql://_sessionminder_role:REPLACE_WITH_GENERATED_PASSWORD@vps8-core:5433/postgres" -f db/02-tables.sql
```

(Adjust the superuser connection to however you normally reach that role on vps8-core's Postgres — this plan assumes the standard shared-instance setup documented in `~/.claude/rules/database-conventions.md`.)

- [x] **Step 6: Verify — shape AND ownership**  
      ↳ Verified: columns match, Owner reads `_sessionminder_role`.

```bash
psql "postgresql://_sessionminder_role:REPLACE_WITH_GENERATED_PASSWORD@vps8-core:5433/postgres" \
  -c '\d _sessionminder.sessions' -c '\dt _sessionminder.*'
```

Expected: column list matches Step 3 exactly, and the `\dt` **Owner column reads `_sessionminder_role`**. If it reads `postgres`, stop — fix with `ALTER TABLE _sessionminder.sessions OWNER TO _sessionminder_role` before continuing (this is the `_foundry` ownership trap; see the audit runbook referenced in `~/.claude/rules/database-conventions.md`).

- [x] **Step 7: Commit**  
      ↳ ccbe26c

```bash
git add db/01-role-and-schema.sql db/02-tables.sql
git commit -m "feat: add sessions table schema"
```

(Note: `REPLACE_WITH_GENERATED_PASSWORD` stays as a literal placeholder in the committed file — the real password never gets committed, only used locally when applying the SQL.)

---

## Task 2: Project scaffold + health check

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/server.ts`
- Create: `src/index.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Produces: `buildServer(): FastifyInstance` (exported from `src/server.ts`) — every later route task registers routes on the instance this factory returns, and every later test calls this same factory.

- [x] **Step 1: Write `package.json`**  
      ↳ Later gained `engines: node >=20` (commit 89b500c).

```json
{
  "name": "session-minder",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "postgres": "^3.4.4"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [x] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

- [x] **Step 3: Install dependencies**

Run: `npm install`

- [x] **Step 4: Write the failing test**

```typescript
// test/server.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

describe('GET /healthz', () => {
  it('returns 200 ok', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

- [x] **Step 5: Run test to verify it fails**  
      ↳ RED confirmed.

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — `Cannot find module '../src/server.js'` (file doesn't exist yet)

- [x] **Step 6: Write `src/server.ts`**  
      ↳ DEVIATION: `logger: process.env.NODE_ENV !== 'test'` instead of `logger: true` — the plan's form put pino JSON in every test's output.

```typescript
// src/server.ts
import Fastify, { FastifyInstance } from 'fastify';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ ok: true }));

  return app;
}
```

- [x] **Step 7: Write `src/index.ts`**

```typescript
// src/index.ts
import { buildServer } from './server.js';

const app = buildServer();
const port = Number(process.env.PORT ?? 3000);
// Loopback by default; production sets HOST to the vps8 tailnet IP (Task 10).
// Never 0.0.0.0 — the service must not ride the public interface (spec:
// tailnet-only, Non-Goals).
const host = process.env.HOST ?? '127.0.0.1';

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

- [x] **Step 8: Run test to verify it passes**  
      ↳ GREEN confirmed.

Run: `npx vitest run test/server.test.ts`
Expected: PASS

- [x] **Step 9: Commit**  
      ↳ DEVIATION: commit amended to 867abc1 to include `package-lock.json`, which the plan's `git add` list omitted.

```bash
git add package.json tsconfig.json src/server.ts src/index.ts test/server.test.ts
git commit -m "feat: scaffold fastify service with health check"
```

---

## Task 3: Database client + noise-flag logic

**Files:**
- Create: `src/db.ts`
- Create: `src/noise.ts`
- Test: `test/noise.test.ts`

**Interfaces:**
- Consumes: `process.env.DATABASE_URL`
- Produces: `getSql(): Sql` (named export from `src/db.ts`, lazily initialized — importing the module never throws; only calling `getSql()` without `DATABASE_URL` does, so tests that mock or never touch the db stay independent of env). Used by the capture route in Task 5/6. `isNoise(input: { durationSeconds: number | null; messageCount: number | null }): boolean` (exported from `src/noise.ts`) — used by the capture route in Task 6.

- [x] **Step 1: Write the failing test**  
      ↳ Later extended with 3 boundary assertions (09fc3ba) — the plan's 5 cases pinned neither threshold constant nor either comparison operator.

```typescript
// test/noise.test.ts
import { describe, it, expect } from 'vitest';
import { isNoise } from '../src/noise.js';

describe('isNoise', () => {
  it('flags a session with under 60 seconds duration and under 3 messages', () => {
    expect(isNoise({ durationSeconds: 10, messageCount: 1 })).toBe(true);
  });

  it('flags a short session with unknown message count (Hermes timeout/cron case)', () => {
    expect(isNoise({ durationSeconds: 5, messageCount: null })).toBe(true);
  });

  it('does not flag a short session with real message traffic', () => {
    expect(isNoise({ durationSeconds: 30, messageCount: 20 })).toBe(false);
  });

  it('does not flag a normal working session', () => {
    expect(isNoise({ durationSeconds: 900, messageCount: 40 })).toBe(false);
  });

  it('does not flag when duration is unknown (session still open)', () => {
    expect(isNoise({ durationSeconds: null, messageCount: null })).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**  
      ↳ RED confirmed.

Run: `npx vitest run test/noise.test.ts`
Expected: FAIL — `Cannot find module '../src/noise.js'`

- [x] **Step 3: Write `src/noise.ts`**

```typescript
// src/noise.ts
// Thresholds are a deliberately conservative starting point (spec: Open
// Question #3 — tune empirically once real Hermes capture data exists).
const NOISE_DURATION_SECONDS = 60;
const NOISE_MESSAGE_COUNT = 3;

// Duration is the primary signal: no platform's end-hook payload reliably
// carries a message count, so a null messageCount must not veto the flag
// (spec: "very short duration and/or very low message count") — otherwise
// the Hermes timeout/cron sessions this feature exists for never get flagged.
export function isNoise(input: {
  durationSeconds: number | null;
  messageCount: number | null;
}): boolean {
  if (input.durationSeconds === null) return false;
  if (input.durationSeconds >= NOISE_DURATION_SECONDS) return false;
  return input.messageCount === null || input.messageCount < NOISE_MESSAGE_COUNT;
}
```

- [x] **Step 4: Run test to verify it passes**  
      ↳ GREEN confirmed.

Run: `npx vitest run test/noise.test.ts`
Expected: PASS

- [x] **Step 5: Write `src/db.ts`**

```typescript
// src/db.ts
import postgres, { type Sql } from 'postgres';

let sql: Sql | undefined;

// Lazy: importing this module must never throw, or every test that touches
// buildServer() (Task 2's healthz test included) would demand a DATABASE_URL.
export function getSql(): Sql {
  if (!sql) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    sql = postgres(connectionString);
  }
  return sql;
}
```

- [x] **Step 6: Add `.env.local` entries**  
      ↳ DEVIATION: done by the controller in the main session, not the implementer, to keep live secrets out of subagent context. `DATABASE_URL` was written at Task 1 — it is the only file the password touches.

Add to `.env.local` (already gitignored per `/project-setup`):

```env
DATABASE_URL=postgresql://_sessionminder_role:REPLACE_WITH_GENERATED_PASSWORD@vps8-core:5433/postgres
SESSION_MINDER_TOKEN=
PORT=3000
# HOST stays unset in dev (server defaults to 127.0.0.1); production sets it
# to the vps8 tailnet IP via the systemd unit (Task 10).
```

Generate the token: `openssl rand -hex 32`, paste into `SESSION_MINDER_TOKEN=`.

- [x] **Step 7: Commit**  
      ↳ 0e6c1ae, plus follow-up 09fc3ba adding `test/db.test.ts`, which pins the lazy-init contract the plan left unverified.

```bash
git add src/db.ts src/noise.ts test/noise.test.ts
git commit -m "feat: add db client and noise-flag threshold logic"
```

(`.env.local` is gitignored — do not add it.)

---

## Task 4: Bearer-token auth

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `process.env.SESSION_MINDER_TOKEN`
- Produces: `requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>` (exported from `src/auth.ts`) — registered as a Fastify `preHandler` on the capture route in Task 5.

- [x] **Step 1: Write the failing test**  
      ↳ Later extended (554b5da) to cover the fail-closed invariant and to assert the 401 body, which the plan's 3 cases left unpinned.

```typescript
// test/auth.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../src/auth.js';

function mockReply() {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
  return reply;
}

describe('requireAuth', () => {
  beforeEach(() => {
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
  });

  it('rejects a missing Authorization header', async () => {
    const request = { headers: {} } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('rejects an incorrect token', async () => {
    const request = {
      headers: { authorization: 'Bearer wrong-token' },
    } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('allows the correct token', async () => {
    const request = {
      headers: { authorization: 'Bearer test-token-123' },
    } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run test to verify it fails**  
      ↳ RED confirmed.

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL — `Cannot find module '../src/auth.js'`

- [x] **Step 3: Write `src/auth.ts`**

```typescript
// src/auth.ts
import type { FastifyReply, FastifyRequest } from 'fastify';

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const expected = process.env.SESSION_MINDER_TOKEN;
  const header = request.headers.authorization;
  const provided = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  if (!expected || !provided || provided !== expected) {
    reply.code(401).send({ error: 'unauthorized' });
  }
}
```

- [x] **Step 4: Run test to verify it passes**  
      ↳ GREEN confirmed.

Run: `npx vitest run test/auth.test.ts`
Expected: PASS

- [x] **Step 5: Commit**  
      ↳ eaa8a9d, plus 554b5da.

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat: add bearer token auth guard"
```

---

## Task 5: Capture route — session start

**Files:**
- Create: `src/routes/capture.ts`
- Modify: `src/server.ts`
- Test: `test/capture.test.ts`

**Interfaces:**
- Consumes: `getSql` from `src/db.ts` (Task 3), `requireAuth` from `src/auth.ts` (Task 4)
- Produces: `registerCaptureRoute(app: FastifyInstance): void` (exported from `src/routes/capture.ts`) — called from `buildServer()` in `src/server.ts`. Route contract: `POST /api/sessions/capture` body `{ platform: 'claude_code'|'hermes'|'kimi_code', external_session_id: string, event: 'start'|'end', host: string, project_path?: string, message_count?: number }`.

- [x] **Step 1: Write the failing test**  
      ↳ Later extended (636164b): the plan's malformed-payload case failed validation before the allowlist check, so deleting the allowlist passed all 3 tests.

```typescript
// test/capture.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above top-level const declarations, so the
// mock must come from vi.hoisted() — a plain `const mockSql = vi.fn()` here
// would throw "Cannot access 'mockSql' before initialization".
const { mockSql } = vi.hoisted(() => ({ mockSql: vi.fn() }));
vi.mock('../src/db.js', () => ({ getSql: () => mockSql }));

const { buildServer } = await import('../src/server.js');

describe('POST /api/sessions/capture — start event', () => {
  beforeEach(() => {
    mockSql.mockReset();
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
  });

  it('rejects requests without a valid bearer token', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      payload: {
        platform: 'claude_code',
        external_session_id: 'abc-123',
        event: 'start',
        host: 'mbp',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('inserts a new row on a start event', async () => {
    mockSql.mockResolvedValueOnce([]); // the INSERT ... ON CONFLICT query result

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: {
        platform: 'claude_code',
        external_session_id: 'abc-123',
        event: 'start',
        host: 'mbp',
        project_path: '/home/john/dev/active/session-minder',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it('rejects a malformed payload', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: { platform: 'not-a-real-platform', event: 'start' },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [x] **Step 2: Run test to verify it fails**  
      ↳ RED confirmed (404s where 401/204/400 expected).

Run: `npx vitest run test/capture.test.ts`
Expected: FAIL — the route isn't registered yet, so every request returns 404 where the tests expect 401/204/400

- [x] **Step 3: Write `src/routes/capture.ts`** (start-event handling only; end-event added in Task 6)

```typescript
// src/routes/capture.ts
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db.js';
import { requireAuth } from '../auth.js';

const VALID_PLATFORMS = ['claude_code', 'hermes', 'kimi_code'] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

interface CapturePayload {
  platform: Platform;
  external_session_id: string;
  event: 'start' | 'end';
  host: string;
  project_path?: string;
  message_count?: number;
}

function isValidPayload(body: unknown): body is CapturePayload {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.external_session_id === 'string' &&
    typeof b.host === 'string' &&
    (b.event === 'start' || b.event === 'end') &&
    typeof b.platform === 'string' &&
    (VALID_PLATFORMS as readonly string[]).includes(b.platform) &&
    (b.project_path === undefined || typeof b.project_path === 'string') &&
    (b.message_count === undefined || typeof b.message_count === 'number')
  );
}

export function registerCaptureRoute(app: FastifyInstance): void {
  app.post(
    '/api/sessions/capture',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = request.body;
      if (!isValidPayload(body)) {
        reply.code(400).send({ error: 'invalid payload' });
        return;
      }

      const sql = getSql();

      if (body.event === 'start') {
        await sql`
          INSERT INTO _sessionminder.sessions
            (platform, external_session_id, host, project_path, started_at)
          VALUES
            (${body.platform}, ${body.external_session_id}, ${body.host},
             ${body.project_path ?? null}, now())
          ON CONFLICT (platform, external_session_id) DO NOTHING
        `;
        reply.code(204).send();
        return;
      }

      // 'end' event handled in Task 6
      reply.code(501).send({ error: 'end event not yet implemented' });
    }
  );
}
```

- [x] **Step 4: Wire it into `src/server.ts`**  
      ↳ DEVIATION: kept the Task 2 `NODE_ENV` logger gate rather than restoring the plan's literal `logger: true`.

```typescript
// src/server.ts
import Fastify, { FastifyInstance } from 'fastify';
import { registerCaptureRoute } from './routes/capture.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ ok: true }));
  registerCaptureRoute(app);

  return app;
}
```

- [x] **Step 5: Run tests to verify they pass**  
      ↳ GREEN confirmed.

Run: `npx vitest run test/capture.test.ts`
Expected: PASS (all three cases)

- [x] **Step 6: Commit**  
      ↳ 72870fd, plus 636164b pinning the `ON CONFLICT` clause and the platform allowlist.

```bash
git add src/routes/capture.ts src/server.ts test/capture.test.ts
git commit -m "feat: add capture endpoint start-event handling"
```

---

## Task 6: Capture route — session end + noise flag

**Files:**
- Modify: `src/routes/capture.ts`
- Modify: `test/capture.test.ts`

**Interfaces:**
- Consumes: `isNoise` from `src/noise.ts` (Task 3)
- Produces: full `event: 'end'` handling on the same route from Task 5.

- [x] **Step 1: Add the failing tests**  
      ↳ Extended beyond the plan's single case to pin `DO UPDATE`, that `SET` never touches `started_at`, and the null-`message_count` Hermes case.

Append to `test/capture.test.ts`:

```typescript
describe('POST /api/sessions/capture — end event', () => {
  beforeEach(() => {
    mockSql.mockReset();
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
  });

  it('upserts the row with ended_at, message_count, and noise_flag', async () => {
    // Two sql calls: the started_at SELECT, then the upsert.
    mockSql.mockResolvedValue([]);

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: {
        platform: 'hermes',
        external_session_id: 'xyz-789',
        event: 'end',
        host: 'vps8-core',
        message_count: 1,
      },
    });

    expect(res.statusCode).toBe(204);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
```

- [x] **Step 2: Run test to verify it fails**  
      ↳ RED confirmed (501 for `end`).

Run: `npx vitest run test/capture.test.ts`
Expected: FAIL — current handler returns 501 for `end`

- [x] **Step 3: Implement end-event handling in `src/routes/capture.ts`**  
      ↳ Later hardened (3d861e3): `message_count = COALESCE(...)` so a repeat end event cannot null out a recorded count.

Replace the `// 'end' event handled in Task 6` block with:

```typescript
      // event === 'end'
      const messageCount = body.message_count ?? null;

      const [existing] = await sql<{ started_at: Date }[]>`
        SELECT started_at FROM _sessionminder.sessions
        WHERE platform = ${body.platform}
          AND external_session_id = ${body.external_session_id}
      `;

      const durationSeconds = existing
        ? (Date.now() - new Date(existing.started_at).getTime()) / 1000
        : null;

      const noiseFlag = isNoise({ durationSeconds, messageCount });

      // Upsert, not plain UPDATE: if the start capture was missed (service
      // down, machine offline), the end event still records the session
      // instead of matching zero rows and vanishing (spec Data Model: "the
      // end hook upserts"). In the missed-start case started_at is unknown,
      // so it falls back to now() and durationSeconds stays null.
      await sql`
        INSERT INTO _sessionminder.sessions
          (platform, external_session_id, host, started_at, ended_at,
           message_count, noise_flag)
        VALUES
          (${body.platform}, ${body.external_session_id}, ${body.host},
           now(), now(), ${messageCount}, ${noiseFlag})
        ON CONFLICT (platform, external_session_id) DO UPDATE
        SET ended_at = now(),
            message_count = ${messageCount},
            noise_flag = ${noiseFlag}
      `;
      reply.code(204).send();
      return;
```

Add the import at the top of the file:

```typescript
import { isNoise } from '../noise.js';
```

- [x] **Step 4: Run tests to verify they pass**  
      ↳ GREEN confirmed.

Run: `npx vitest run test/capture.test.ts`
Expected: PASS (all four cases)

- [x] **Step 5: Commit**  
      ↳ 018c27b

```bash
git add src/routes/capture.ts test/capture.test.ts
git commit -m "feat: add capture endpoint end-event handling with noise-flag calc"
```

---

## Task 7: Claude Code hook scripts

**Files:**
- Create: `hooks/claude-code/session-start.sh`
- Create: `hooks/claude-code/session-end.sh`
- Modify: `~/.claude/settings.json` (user-level, outside this repo — see Step 4)

**Interfaces:**
- Consumes: `POST /api/sessions/capture` (Tasks 5–6), reads `SESSION_MINDER_URL` and `SESSION_MINDER_TOKEN` from the environment (set in the shell profile or `~/.claude/settings.json` env block on whatever machine the hook runs on — not from this repo's `.env.local`, since Claude Code hooks run outside this project's process). Scripts require `jq` (`apt`/`brew install jq` if a machine lacks it).

- [x] **Step 1: Write `hooks/claude-code/session-start.sh`**  
      ↳ DEVIATION: `host` derived from the Tailscale short name, not `$(hostname)` — vps8's hostname is `srv1086450`. Later gained `setsid` and a token fallback.

```bash
#!/usr/bin/env bash
# Claude Code SessionStart hook. Reads the hook's JSON payload from stdin,
# fires a fire-and-forget capture POST. Never blocks or fails the session:
# all errors are swallowed (spec: Capture Pipeline — non-blocking by design).
# jq is used both ways: parsing the payload and building the POST body, so
# paths with spaces/quotes stay valid JSON.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
cwd="$(echo "$payload" | jq -r '.cwd // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

body="$(jq -n --arg sid "$session_id" --arg host "$(hostname)" --arg cwd "$cwd" \
  '{platform: "claude_code", external_session_id: $sid, event: "start", host: $host}
   + (if $cwd == "" then {} else {project_path: $cwd} end)')"

curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${SESSION_MINDER_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
```

- [x] **Step 2: Write `hooks/claude-code/session-end.sh`**  
      ↳ Same deviations as Step 1.

```bash
#!/usr/bin/env bash
# Claude Code SessionEnd hook — fires once, when the session actually ends.
# (Deliberately NOT the Stop hook: Stop fires after every assistant response,
# which would stamp ended_at on the first turn and hammer the endpoint all
# session.) Same fire-and-forget contract as session-start.sh.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

body="$(jq -n --arg sid "$session_id" --arg host "$(hostname)" \
  '{platform: "claude_code", external_session_id: $sid, event: "end", host: $host}')"

curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${SESSION_MINDER_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
```

- [x] **Step 3: Make them executable**

```bash
chmod +x hooks/claude-code/session-start.sh hooks/claude-code/session-end.sh
```

- [x] **Step 4: Wire into `~/.claude/settings.json` — user-level, on every machine Claude Code runs on**  
      ↳ Registered user-level on vps8 only — the sole machine running Claude Code, so the plan's per-machine note does not apply. Merged programmatically; existing `PostToolUse` hook preserved.

**Not this repo's `.claude/settings.json`**: project-level hooks fire only for sessions started inside this one repo, and the spec requires capturing *every* session. Register user-level on each machine (vps8 now; mbp/mini when their hook environments are set up), merging with any existing content — don't overwrite other keys:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/john/dev/active/session-minder/hooks/claude-code/session-start.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/john/dev/active/session-minder/hooks/claude-code/session-end.sh"
          }
        ]
      }
    ]
  }
}
```

Notes:
- `SessionEnd`, not `Stop` — `Stop` fires after every assistant response, which would set `ended_at` on the first turn (destroying the spec's "null = still open" state) and re-POST all session long.
- Matcher-less `SessionStart` also fires on resume/clear/compact — safe, per the idempotent `ON CONFLICT DO NOTHING` insert (spec: Open Question #4 fallback).
- The script path above is the vps8 checkout; on other machines, point at a local copy of the scripts.
- This is Claude Code's own settings.json hook config format; confirm against current Claude Code docs at implementation time in case the schema has moved.

- [x] **Step 5: Manual verification**  
      ↳ VERIFIED on a real session: `d4a3cfd8-…`, start and end, 505s, correctly not flagged noise.

Set `SESSION_MINDER_URL` and `SESSION_MINDER_TOKEN` in your shell profile (matching the token generated in Task 3, Step 6), start the service (`npm run dev` from Task 2), open a fresh Claude Code session in any repo, then check:

```bash
psql "$DATABASE_URL" -c "SELECT platform, external_session_id, started_at, ended_at FROM _sessionminder.sessions ORDER BY created_at DESC LIMIT 1;"
```

Expected: a row with `platform = claude_code`, a recent `started_at`, and `ended_at` NULL. Then exit that session and re-run the query — `ended_at` should now be set.

- [x] **Step 6: Commit**  
      ↳ 93ff072

```bash
git add hooks/claude-code/session-start.sh hooks/claude-code/session-end.sh
git commit -m "feat: add Claude Code session capture hooks"
```

(`~/.claude/settings.json` lives outside this repo — its change is applied directly on each machine, like the Hermes and Kimi configs in Tasks 8–9.)

---

## Task 8: Hermes hook scripts

**Files:**
- Create: `hooks/hermes/session-start.sh`
- Create: `hooks/hermes/session-end.sh`
- Modify: `~/.hermes/config.yaml` (outside this repo — Hermes's own config, not session-minder's)

**Interfaces:**
- Consumes: `POST /api/sessions/capture` (Tasks 5–6)

- [x] **Step 1: Write `hooks/hermes/session-start.sh`**  
      ↳ DEVIATION: sends `project_path` from the payload's `cwd`, which the plan omitted — the spec assumed Hermes had no cwd, but it does.

```bash
#!/usr/bin/env bash
# Hermes on_session_start shell hook. Same JSON-stdin/fire-and-forget
# contract as the Claude Code hooks (spec: Capture Pipeline). Requires jq.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

body="$(jq -n --arg sid "$session_id" --arg host "$(hostname)" \
  '{platform: "hermes", external_session_id: $sid, event: "start", host: $host}')"

curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${SESSION_MINDER_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
```

- [x] **Step 2: Write `hooks/hermes/session-end.sh`**  
      ↳ DEVIATION: Tailscale host derivation.

```bash
#!/usr/bin/env bash
# Hermes on_session_end shell hook. Requires jq.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

body="$(jq -n --arg sid "$session_id" --arg host "$(hostname)" \
  '{platform: "hermes", external_session_id: $sid, event: "end", host: $host}')"

curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${SESSION_MINDER_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
```

- [x] **Step 3: Make them executable**

```bash
chmod +x hooks/hermes/session-start.sh hooks/hermes/session-end.sh
```

- [x] **Step 4: Wire into `~/.hermes/config.yaml`**  
      ↳ DEVIATION — THE PLAN'S SCHEMA WAS WRONG. Hermes takes `hooks:` as a mapping keyed by event name, not a flat list of `{event, command}`. Also wired the 3 running profile gateways (`mccoy`, `vulcan`, `the-beav`), each of which has its own `config.yaml` and `.env` under its own `HERMES_HOME`.

Add under the `hooks:` block (merge with existing config — do not overwrite other hook entries):

```yaml
hooks:
  - event: on_session_start
    command: /home/john/dev/active/session-minder/hooks/hermes/session-start.sh
  - event: on_session_end
    command: /home/john/dev/active/session-minder/hooks/hermes/session-end.sh
```

Note: first invocation of each (event, command) pair will prompt for consent, recorded in `~/.hermes/shell-hooks-allowlist.json` — approve it once, interactively, the first time each hook fires.

- [x] **Step 5: Manual verification**  
      ↳ VERIFIED on real sessions across all 4 wired profiles.

With the service running and `SESSION_MINDER_URL`/`SESSION_MINDER_TOKEN` set in the environment Hermes runs in, start a Hermes session, approve the consent prompts, then check:

```bash
psql "$DATABASE_URL" -c "SELECT platform, external_session_id, started_at FROM _sessionminder.sessions WHERE platform = 'hermes' ORDER BY created_at DESC LIMIT 1;"
```

Expected: a row with `platform = hermes` and a recent `started_at`.

- [x] **Step 6: Commit**  
      ↳ 62f90af

```bash
git add hooks/hermes/session-start.sh hooks/hermes/session-end.sh
git commit -m "feat: add Hermes session capture hooks"
```

(`~/.hermes/config.yaml` lives outside this repo and isn't committed here — its change is applied directly, per Step 4.)

---

## Task 9: Kimi Code hook scripts

**Files:**
- Create: `hooks/kimi-code/session-start.sh`
- Create: `hooks/kimi-code/session-end.sh`
- Modify: `~/.kimi-code/config.toml` (outside this repo)

**Interfaces:**
- Consumes: `POST /api/sessions/capture` (Tasks 5–6)

- [x] **Step 1: Write `hooks/kimi-code/session-start.sh`**  
      ↳ Same deviations as the Claude Code hooks (Tailscale host, `setsid`, token fallback).

```bash
#!/usr/bin/env bash
# Kimi Code SessionStart hook, matcher=startup only (see Step 4 — resumed
# sessions are intentionally not wired to a matcher here, per spec Open
# Question #4: ignore resume rather than re-fire start). Requires jq.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
cwd="$(echo "$payload" | jq -r '.cwd // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

body="$(jq -n --arg sid "$session_id" --arg host "$(hostname)" --arg cwd "$cwd" \
  '{platform: "kimi_code", external_session_id: $sid, event: "start", host: $host}
   + (if $cwd == "" then {} else {project_path: $cwd} end)')"

curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${SESSION_MINDER_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
```

- [x] **Step 2: Write `hooks/kimi-code/session-end.sh`**  
      ↳ Same.

```bash
#!/usr/bin/env bash
# Kimi Code SessionEnd hook, matcher=exit. Requires jq.

set -u
payload="$(cat)"

session_id="$(echo "$payload" | jq -r '.session_id // empty' 2>/dev/null)"

[ -z "$session_id" ] && exit 0

body="$(jq -n --arg sid "$session_id" --arg host "$(hostname)" \
  '{platform: "kimi_code", external_session_id: $sid, event: "end", host: $host}')"

curl -s -m 2 -X POST "${SESSION_MINDER_URL:-http://vps8-core:3000}/api/sessions/capture" \
  -H "Authorization: Bearer ${SESSION_MINDER_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d "$body" \
  >/dev/null 2>&1 &

exit 0
```

- [x] **Step 3: Make them executable**

```bash
chmod +x hooks/kimi-code/session-start.sh hooks/kimi-code/session-end.sh
```

- [x] **Step 4: Wire into `~/.kimi-code/config.toml`**  
      ↳ Plan's TOML schema confirmed correct. Asserted only the 4 legal fields are used — extra fields make Kimi fail to load the config.

Add (merge with any existing `[[hooks]]` entries):

```toml
[[hooks]]
event = "SessionStart"
matcher = "startup"
command = "/home/john/dev/active/session-minder/hooks/kimi-code/session-start.sh"

[[hooks]]
event = "SessionEnd"
matcher = "exit"
command = "/home/john/dev/active/session-minder/hooks/kimi-code/session-end.sh"
```

- [ ] **Step 5: Manual verification**  
      ↳ SKIPPED — deferred by explicit instruction until Kimi Code is brought online. Scripts are verified at the script level; the token now resolves from `.env.local`, since Kimi has no environment mechanism.

Deferred until Kimi Code is actually brought online for project use (spec: Open Question #2) — this step is a placeholder for that future session, not something to run now. When run: start a fresh Kimi Code session, then check for a `platform = kimi_code` row the same way as Steps 5 in Tasks 7 and 8.

- [x] **Step 6: Commit**  
      ↳ bb8526a

```bash
git add hooks/kimi-code/session-start.sh hooks/kimi-code/session-end.sh
git commit -m "feat: add Kimi Code session capture hooks"
```

---

## Task 10: Deploy to vps8 (tailnet-only)

**Files:**
- Create: `deploy/session-minder.service`

**Interfaces:**
- Consumes: the built service from Tasks 2–6

No reverse-proxy layer: the hook scripts already call `http://vps8-core:3000` directly, so the service binds the tailnet IP itself and UFW opens port 3000 on `tailscale0` only — one moving part fewer than a Caddy hostname, which can be layered on later if ever wanted.

- [x] **Step 1: Write `deploy/session-minder.service`**  
      ↳ DEVIATION: `ExecStart` is `/snap/bin/node .../tsx/dist/cli.mjs`, not `npx tsx` — BOTH npx forms resolve Node to v18.19.1 under systemd, below this project's Node 20+ requirement. Later gained `RestartSec=5` (3d861e3) to survive a tailscaled boot race.

```ini
[Unit]
Description=session-minder capture API
After=network.target tailscaled.service

[Service]
Type=simple
WorkingDirectory=/home/john/dev/active/session-minder
EnvironmentFile=/home/john/dev/active/session-minder/.env.local
# Bind the tailnet IP directly — hooks call http://vps8-core:3000 over the
# tailnet. Never 0.0.0.0 (spec: tailnet-only, Non-Goals).
Environment=HOST=100.118.195.63
ExecStart=/usr/bin/npx tsx src/index.ts
Restart=on-failure
User=john

[Install]
WantedBy=multi-user.target
```

(If `npx` isn't at `/usr/bin/npx` — e.g. node via nvm — set `ExecStart` to the path `which npx` reports.)

- [x] **Step 2: Open port 3000 on the tailnet interface only**  
      ↳ DONE BY JOHN (sudo).

Match the existing Postgres-on-tailnet UFW pattern (`~/.claude/rules/infrastructure.md`):

```bash
sudo ufw allow in on tailscale0 to any port 3000 proto tcp
```

No public-interface rule — the tailnet bind plus the tailscale0-only UFW rule together keep the service invisible from the internet.

- [x] **Step 3: Install and start the service**  
      ↳ DONE BY JOHN (sudo). Verified `active (running)`, enabled, bound to the tailnet IP only.

```bash
sudo cp deploy/session-minder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now session-minder
sudo systemctl status session-minder
```

Expected: `active (running)`.

- [x] **Step 4: Smoke test — reachable from the tailnet, invisible from the internet**  
      ↳ Same-host checks pass: tailnet IP and MagicDNS reachable, loopback refuses, public IP unreachable. The cross-tailnet leg from mbp/mini was N/A — vps8 is the only machine running these tools.

From another tailnet machine (e.g. mbp):

```bash
curl -s http://vps8-core:3000/healthz
```

Expected: `{"ok":true}`

Then confirm the public interface is closed:

```bash
curl -s -m 3 http://72.60.27.146:3000/healthz || echo "publicly unreachable — correct"
```

Expected: the fallback message, not a healthz response.

- [x] **Step 5: Commit**  
      ↳ 0b0196e

```bash
git add deploy/session-minder.service
git commit -m "feat: add systemd unit for tailnet-only deployment"
```

---

## Definition of Done for Phase 1

- All ten tasks committed.
- `npm test` passes with all Vitest suites green.
- `curl` against the deployed tailnet endpoint succeeds for both `start` and `end` events, for at least Claude Code and Hermes (Kimi Code deferred per Task 9, Step 5).
- The three old Markdown index files (`~/idea-foundry/idea-foundry-vault/_system/{claude,hermes,kimi}-session-index.md`) are left untouched by this phase — deciding whether/how to retire them is a Phase 2 (or later) decision, not part of this plan.
