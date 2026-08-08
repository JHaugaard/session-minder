# session-minder Phase 2.a: Herdr Integration Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "jump back into that session" real — enrich captured sessions with their Herdr pane identity, and add one server-side endpoint that resolves a stored session to a live pane focus, a resumed pane, or a copyable command.

**Architecture:** Two independent halves. (1) *Capture enrichment* — the existing fire-and-forget hook scripts read the `HERDR_*` environment Herdr exports into every pane and pass it through to `POST /api/sessions/capture`, which merges it into the existing `raw_metadata` jsonb column. No schema change, no socket call, no new failure mode in the capture path. (2) *Attach contract* — a new `POST /api/sessions/:id/attach` endpoint talks to the Herdr socket API over a unix socket, joining `sessions.external_session_id` to a live pane's `agent_session.value`, and resolving to one of three actions. All Herdr knowledge stays behind session-minder's own API so Herdr can be dropped without touching the DB contract.

**Tech Stack:** Node.js 20+, TypeScript, Fastify 4, `postgres` (postgres.js), Vitest, `node:net` for the unix socket (no new dependency). Bash + `jq` for hooks. Herdr 0.7.5 socket API (newline-delimited JSON).

## Global Constraints

- Single-user bearer-token auth only — the attach endpoint uses the same `requireAuth` preHandler as capture. No new auth mechanism (spec: Non-Goals).
- Tailnet-only hosting on vps8 — no public exposure (spec: Non-Goals).
- **No new npm dependencies.** The socket client uses `node:net`. (Standing rule: adding a dependency is proposal-first.)
- **No persistent event listener / no daemon.** `events.subscribe` is out of scope — the attach endpoint opens a socket, asks one question, and closes it (spec: Design guards).
- **Keep the Herdr layer thin and behind session-minder's own API.** The dashboard calls session-minder only; session-minder translates to Herdr. If Herdr is dropped, the endpoint degrades to printing native resume commands and the DB contract does not change (spec: Design guards).
- Capture stays fire-and-forget and non-blocking: ~2s timeout, errors swallowed, never visible mid-session (spec: Capture Pipeline).
- `raw_metadata` is a `jsonb NOT NULL DEFAULT '{}'` column that already exists — **no migration in this phase** (spec: 2.a scope, step 2).
- Herdr socket requests **must send `id` as a JSON string.** An integer is rejected with `invalid request: invalid type: integer 1, expected a string` (spec: Spike results).
- A pane with no `agent_session` is "not live", never an error — panes whose agent started before the Herdr integration was installed simply lack the field (spec: What Herdr provides).
- Sessions whose `host` differs from the host session-minder runs on fall through to the degrade path — the socket is only locally reachable (spec: Design guards, Server locality).
- **Tests must pin the behavior the spec singles out, not merely that something happened.** Phase 1's retro found every planned test asserted "a query ran" rather than the rule; four extra commits existed only to close that gap. Each test below names the rule it pins.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/routes/capture.ts` *(modify)* | Accept an optional `herdr` object on the capture payload; merge it into `raw_metadata` |
| `hooks/claude-code/session-start.sh` *(modify)* | Read `HERDR_*` env, add `herdr` to the POST body |
| `hooks/claude-code/session-end.sh` *(modify)* | Same |
| `hooks/hermes/session-start.sh` *(modify)* | Same |
| `hooks/hermes/session-end.sh` *(modify)* | Same |
| `src/herdr.ts` *(create)* | Herdr socket transport: discovery, one-shot request/response, typed `pane.list` / `pane.focus` / `tab.create` / `agent.start` wrappers. The only file that knows the wire protocol. |
| `src/attach.ts` *(create)* | Pure resolver: given a session row + a pane list (or `null` for unreachable), decide which of the three actions to take. No I/O — this is where the branch rules are testable without a socket. |
| `src/routes/attach.ts` *(create)* | HTTP surface: `POST /api/sessions/:id/attach`. Loads the row, calls the resolver, executes the chosen Herdr call. |
| `src/server.ts` *(modify)* | Register the attach route |
| `test/capture.test.ts` *(modify)* | Enrichment merge behavior |
| `test/herdr.test.ts` *(create)* | Socket client against a **real** temporary unix socket server |
| `test/attach.test.ts` *(create)* | Resolver branch rules |
| `test/attach-route.test.ts` *(create)* | Endpoint wiring with the Herdr client faked |

Splitting the pure resolver (`attach.ts`) from the transport (`herdr.ts`) is the load-bearing decision here: the three branch rules are the part with actual logic, and this keeps them testable with plain objects instead of socket fixtures.

---

## Task 1: Capture route accepts and merges Herdr pane metadata

**Files:**
- Modify: `src/routes/capture.ts`
- Test: `test/capture.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the wire contract Task 2's hooks target — an optional `herdr` object on the capture payload with all-string fields:
  ```ts
  interface HerdrCaptureRef {
    session: string;      // HERDR_SESSION,      e.g. "herdr-4up"
    workspace_id: string; // HERDR_WORKSPACE_ID, e.g. "w9"
    tab_id: string;       // HERDR_TAB_ID,       e.g. "w9:t1"
    pane_id: string;      // HERDR_PANE_ID,      e.g. "w9:p1"
    socket_path: string;  // HERDR_SOCKET_PATH
  }
  ```
  Stored at `raw_metadata.herdr`.

- [ ] **Step 1: Write the failing tests**

Add to `test/capture.test.ts`, inside the existing `describe('POST /api/sessions/capture — start event', ...)` block:

```ts
  it('stores Herdr pane identity under raw_metadata.herdr on start', async () => {
    mockSql.mockResolvedValueOnce([]);

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: {
        platform: 'claude_code',
        external_session_id: 'abc-123',
        event: 'start',
        host: 'vps8-core',
        project_path: '/home/john/dev/active/session-minder',
        herdr: {
          session: 'herdr-4up',
          workspace_id: 'w9',
          tab_id: 'w9:t1',
          pane_id: 'w9:p1',
          socket_path: '/home/john/.config/herdr/sessions/herdr-4up/herdr.sock',
        },
      },
    });

    expect(res.statusCode).toBe(204);

    // Pins the nesting rule: the pane identity must land under the `herdr`
    // KEY of raw_metadata, not at the top level. A later consumer reading
    // raw_metadata.herdr.pane_id depends on exactly this shape.
    const [, ...values] = mockSql.mock.calls[0];
    const rawMetadata = values[values.length - 1];
    expect(rawMetadata).toEqual({
      herdr: {
        session: 'herdr-4up',
        workspace_id: 'w9',
        tab_id: 'w9:t1',
        pane_id: 'w9:p1',
        socket_path: '/home/john/.config/herdr/sessions/herdr-4up/herdr.sock',
      },
    });
  });

  it('sends an empty object for raw_metadata when not in a Herdr pane', async () => {
    mockSql.mockResolvedValueOnce([]);

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: {
        platform: 'claude_code',
        external_session_id: 'no-herdr',
        event: 'start',
        host: 'mbp',
      },
    });

    // Pins the backward-compatibility rule: hooks on machines with no Herdr
    // (mbp, mini) omit the field entirely and must still capture normally.
    expect(res.statusCode).toBe(204);
    const [, ...values] = mockSql.mock.calls[0];
    expect(values[values.length - 1]).toEqual({});
  });

  it('rejects a herdr object whose fields are not all strings', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: {
        platform: 'claude_code',
        external_session_id: 'abc-123',
        event: 'start',
        host: 'vps8-core',
        herdr: { session: 'herdr-4up', pane_id: 42 },
      },
    });

    // Pins validation: raw_metadata is queried by later consumers, so a
    // malformed herdr blob must be refused rather than silently stored.
    expect(res.statusCode).toBe(400);
  });
```

And add to the end-event describe block (`describe('POST /api/sessions/capture — end event', ...)`):

```ts
  it('merges Herdr metadata into existing raw_metadata on end, not replacing it', async () => {
    mockSql.mockResolvedValueOnce([{ started_at: new Date(Date.now() - 600_000) }]);
    mockSql.mockResolvedValueOnce([]);

    const app = buildServer();
    await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: {
        platform: 'claude_code',
        external_session_id: 'abc-123',
        event: 'end',
        host: 'vps8-core',
        herdr: {
          session: 'herdr-4up',
          workspace_id: 'w9',
          tab_id: 'w9:t1',
          pane_id: 'w9:p1',
          socket_path: '/home/john/.config/herdr/sessions/herdr-4up/herdr.sock',
        },
      },
    });

    // Pins the merge rule specifically: `||` concatenation preserves any
    // other keys already in raw_metadata. A plain assignment would pass a
    // "did it store the value" assertion while silently destroying data.
    const [strings] = mockSql.mock.calls[1];
    expect(strings.join('?')).toMatch(
      /raw_metadata = _sessionminder\.sessions\.raw_metadata \|\|/
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/capture.test.ts`
Expected: FAIL — the new assertions fail because `raw_metadata` is not yet in the interpolated values (`values[values.length - 1]` is currently `project_path`), and the end-event SQL contains no `raw_metadata` clause.

- [ ] **Step 3: Add the payload type and validation**

In `src/routes/capture.ts`, add above `interface CapturePayload`:

```ts
// Herdr exports these into every pane it owns; the hook scripts pass them
// straight through. Kept as a flat all-strings object so validation is a
// one-liner and the stored jsonb stays predictable for later consumers.
interface HerdrCaptureRef {
  session: string;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  socket_path: string;
}

const HERDR_REF_FIELDS = [
  'session',
  'workspace_id',
  'tab_id',
  'pane_id',
  'socket_path',
] as const;

function isValidHerdrRef(value: unknown): value is HerdrCaptureRef {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return HERDR_REF_FIELDS.every((f) => typeof v[f] === 'string');
}
```

Add the field to `CapturePayload`:

```ts
interface CapturePayload {
  platform: Platform;
  external_session_id: string;
  event: 'start' | 'end';
  host: string;
  project_path?: string;
  message_count?: number;
  herdr?: HerdrCaptureRef;
}
```

And add this clause to the `return (...)` expression in `isValidPayload`, before the closing paren:

```ts
    && (b.herdr === undefined || isValidHerdrRef(b.herdr))
```

- [ ] **Step 4: Thread raw_metadata through both SQL statements**

In `registerCaptureRoute`, immediately after `const sql = getSql();` add:

```ts
      // `{}` (not null) when absent: the column is NOT NULL, and jsonb `||`
      // with an empty object is a no-op, so both branches use one value.
      const rawMetadata = body.herdr ? { herdr: body.herdr } : {};
```

Replace the start-event INSERT with:

```ts
        await sql`
          INSERT INTO _sessionminder.sessions
            (platform, external_session_id, host, project_path, started_at,
             raw_metadata)
          VALUES
            (${body.platform}, ${body.external_session_id}, ${body.host},
             ${body.project_path ?? null}, now(), ${sql.json(rawMetadata)})
          ON CONFLICT (platform, external_session_id) DO NOTHING
        `;
```

Replace the end-event upsert with:

```ts
      await sql`
        INSERT INTO _sessionminder.sessions
          (platform, external_session_id, host, started_at, ended_at,
           message_count, noise_flag, raw_metadata)
        VALUES
          (${body.platform}, ${body.external_session_id}, ${body.host},
           now(), now(), ${messageCount}, ${noiseFlag}, ${sql.json(rawMetadata)})
        ON CONFLICT (platform, external_session_id) DO UPDATE
        SET ended_at = now(),
            message_count = COALESCE(${messageCount}, _sessionminder.sessions.message_count),
            noise_flag = ${noiseFlag},
            raw_metadata = _sessionminder.sessions.raw_metadata || ${sql.json(rawMetadata)}
      `;
```

Note the merge direction: the *new* value wins on key collision, which is what we want — a session resumed in a different pane should record the pane it most recently lived in. The start event deliberately does not merge, because `ON CONFLICT DO NOTHING` means a resumed session keeps its original row untouched, consistent with the existing `started_at` policy.

- [ ] **Step 5: Update the existing start-event test's value assertion**

The existing `'inserts a new row on a start event'` test asserts `values` equals a 4-element array. Adding `raw_metadata` makes it 5. Update it:

```ts
    expect(values).toEqual([
      'claude_code',
      'abc-123',
      'mbp',
      '/home/john/dev/active/session-minder',
      {},
    ]);
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/routes/capture.ts test/capture.test.ts
git commit -m "feat(capture): accept Herdr pane identity and merge into raw_metadata"
```

---

## Task 2: Hooks send Herdr pane identity

**Files:**
- Modify: `hooks/claude-code/session-start.sh`
- Modify: `hooks/claude-code/session-end.sh`
- Modify: `hooks/hermes/session-start.sh`
- Modify: `hooks/hermes/session-end.sh`
- Test: manual, per the existing convention ("Hook scripts: manual verification against a live Claude Code and Hermes session. Thin enough that heavy automated coverage isn't warranted." — spec: Testing)

**Interfaces:**
- Consumes: the `herdr` payload field from Task 1.
- Produces: nothing further tasks consume — this is the capture-side leaf.

**Note on Kimi Code:** `hooks/kimi-code/*.sh` are deliberately **not** modified. Kimi capture is deferred until Kimi Code is brought online for real project use (spec: Open Question 2), and its hooks have never been live-verified. Adding an unverifiable code path to them now would be scope creep. This is a knowing, recorded omission.

- [ ] **Step 1: Add the Herdr env block to `hooks/claude-code/session-start.sh`**

Insert after the token-resolution block (after the `fi` on line 35), before `body="$(jq -n ...)"`:

```bash
# Herdr pane identity (spec Phase 2.a: capture enrichment). Herdr exports these
# into every pane it owns; outside a pane they are simply unset and the object
# is omitted. Guard mirrors Herdr's own hook script — HERDR_ENV=1 plus a
# non-empty socket path and pane id — so we agree with Herdr on what "inside a
# pane" means. This is a pure env read: no socket call, so it cannot add
# latency or a new failure mode to a fire-and-forget hook.
herdr_json=""
if [ "${HERDR_ENV:-}" = "1" ] && [ -n "${HERDR_SOCKET_PATH:-}" ] && [ -n "${HERDR_PANE_ID:-}" ]; then
  herdr_json="$(jq -n \
    --arg session "${HERDR_SESSION:-}" \
    --arg workspace_id "${HERDR_WORKSPACE_ID:-}" \
    --arg tab_id "${HERDR_TAB_ID:-}" \
    --arg pane_id "${HERDR_PANE_ID:-}" \
    --arg socket_path "${HERDR_SOCKET_PATH:-}" \
    '{herdr: {session: $session, workspace_id: $workspace_id, tab_id: $tab_id,
              pane_id: $pane_id, socket_path: $socket_path}}' 2>/dev/null)"
fi
```

Then change the body construction from:

```bash
body="$(jq -n --arg sid "$session_id" --arg host "$host" --arg cwd "$cwd" \
  '{platform: "claude_code", external_session_id: $sid, event: "start", host: $host}
   + (if $cwd == "" then {} else {project_path: $cwd} end)')"
```

to:

```bash
body="$(jq -n --arg sid "$session_id" --arg host "$host" --arg cwd "$cwd" \
  --argjson herdr "${herdr_json:-{\}}" \
  '{platform: "claude_code", external_session_id: $sid, event: "start", host: $host}
   + (if $cwd == "" then {} else {project_path: $cwd} end)
   + $herdr')"
```

The `${herdr_json:-{\}}` default is an empty JSON object, so `+ $herdr` is a no-op when not in a pane — the same "one code path, two cases" shape the server side uses.

- [ ] **Step 2: Verify the not-in-a-pane case produces the old body exactly**

Run:

```bash
env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_PANE_ID \
  bash -c 'echo "{\"session_id\":\"test-uuid\",\"cwd\":\"/tmp\"}" | SESSION_MINDER_URL=http://127.0.0.1:9 bash -x hooks/claude-code/session-start.sh' 2>&1 | grep -- '-d '
```

Expected: the `-d` argument is a JSON object with exactly `platform`, `external_session_id`, `event`, `host`, `project_path` — **no `herdr` key**. This is the regression that matters: every machine without Herdr (mbp, mini) must keep capturing exactly as before.

- [ ] **Step 3: Verify the in-a-pane case includes the herdr object**

Run (from inside a Herdr pane, where the `HERDR_*` vars are live):

```bash
echo '{"session_id":"test-uuid","cwd":"/tmp"}' | SESSION_MINDER_URL=http://127.0.0.1:9 bash -x hooks/claude-code/session-start.sh 2>&1 | grep -- '-d '
```

Expected: the `-d` argument contains a `herdr` object with all five string fields populated from the environment.

- [ ] **Step 4: Apply the same change to the other three hooks**

Repeat Steps 1–3 for:
- `hooks/claude-code/session-end.sh` — same env block; the body jq gains `--argjson herdr "${herdr_json:-{\}}"` and `+ $herdr`. That file's body has no `$cwd` term, so the expression becomes:
  ```bash
  body="$(jq -n --arg sid "$session_id" --arg host "$host" \
    --argjson herdr "${herdr_json:-{\}}" \
    '{platform: "claude_code", external_session_id: $sid, event: "end", host: $host}
     + $herdr')"
  ```
- `hooks/hermes/session-start.sh` — identical to the Claude start hook except `platform: "hermes"`.
- `hooks/hermes/session-end.sh` — identical to the Claude end hook except `platform: "hermes"`.

- [ ] **Step 5: End-to-end verification against the live service**

Start a fresh Claude Code session inside a Herdr pane, then:

```bash
set -a; . ./.env.local; set +a
psql "$DATABASE_URL" -tAc "SELECT external_session_id, raw_metadata FROM _sessionminder.sessions ORDER BY started_at DESC LIMIT 1;"
```

Expected: the newest row's `raw_metadata` is `{"herdr": {"session": "...", "workspace_id": "w#", "tab_id": "w#:t#", "pane_id": "w#:p#", "socket_path": "..."}}` — not `{}`.

- [ ] **Step 6: Commit**

```bash
git add hooks/claude-code/session-start.sh hooks/claude-code/session-end.sh \
        hooks/hermes/session-start.sh hooks/hermes/session-end.sh
git commit -m "feat(hooks): pass Herdr pane identity through to capture"
```

---

## Task 3: Herdr socket client

**Files:**
- Create: `src/herdr.ts`
- Test: `test/herdr.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, for Tasks 4 and 5:
  ```ts
  export interface HerdrAgentSession { source: string; agent: string; kind: string; value: string }
  export interface HerdrPane {
    pane_id: string; workspace_id: string; tab_id: string;
    cwd: string | null; agent: string | null;
    agent_session?: HerdrAgentSession;
  }
  export interface HerdrClient {
    listPanes(): Promise<HerdrPane[]>;
    focusPane(paneId: string): Promise<void>;
    createTab(opts: { cwd: string; workspaceId?: string; label?: string }): Promise<{ paneId: string; tabId: string }>;
    startAgent(opts: { paneId: string; kind: string; name: string; args: string[] }): Promise<{ argv: string[] }>;
  }
  export class HerdrUnreachableError extends Error {}
  export function createHerdrClient(socketPath: string): HerdrClient;
  export async function discoverHerdrSocket(): Promise<string | null>;
  ```

**Wire protocol facts (verified against Herdr 0.7.5 — do not re-derive):**
- Newline-delimited JSON, one request per connection is sufficient. Request: `{"id": "<string>", "method": "<name>", "params": {...}}`. **`id` must be a string.**
- `pane.list` → `{"id":"...","result":{"type":"pane_list","panes":[PaneInfo,...]}}`
- `pane.focus` params `{pane_id}` → `{"result":{"type":"ok"}}`
- `tab.create` params `{cwd, workspace_id?, label?, focus?}` → `{"result":{"type":"tab_created","tab":{...},"root_pane":{"pane_id":"...",...}}}`
- `agent.start` params `{name, kind, pane_id, args?, timeout_ms?}` → `{"result":{"type":"agent_started","agent":{...},"argv":[...]}}`
- Errors: `{"id":"","error":{"code":"...","message":"..."}}`
- `PaneInfo` fields used here: `pane_id`, `workspace_id`, `tab_id`, `cwd`, `agent`, `agent_session` (present only when Herdr holds a native session reference).

- [ ] **Step 1: Write the failing tests**

Create `test/herdr.test.ts`. These run against a **real** unix socket server rather than a mocked transport — the string-`id` requirement and the newline framing are wire-level rules that a mock would paper over.

```ts
// test/herdr.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHerdrClient, HerdrUnreachableError } from '../src/herdr.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

// Stands up a throwaway unix socket that replies with `responder(request)`.
// Records every raw request line so tests can assert on the wire format.
function fakeHerdr(responder: (req: any) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-test-'));
  const socketPath = join(dir, 'herdr.sock');
  const received: any[] = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const req = JSON.parse(line);
        received.push(req);
        conn.write(JSON.stringify(responder(req)) + '\n');
      }
    });
  });
  server.listen(socketPath);
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, received };
}

describe('Herdr socket client', () => {
  it('sends the request id as a JSON string', async () => {
    const { socketPath, received } = fakeHerdr(() => ({
      id: '1',
      result: { type: 'pane_list', panes: [] },
    }));

    await createHerdrClient(socketPath).listPanes();

    // Pins the spike's hard-won trap: Herdr rejects an integer id outright
    // with "invalid type: integer 1, expected a string". A number here would
    // fail every call at runtime while passing any shape-only assertion.
    expect(typeof received[0].id).toBe('string');
    expect(received[0].method).toBe('pane.list');
  });

  it('returns panes including their agent_session join key', async () => {
    const { socketPath } = fakeHerdr(() => ({
      id: '1',
      result: {
        type: 'pane_list',
        panes: [
          {
            pane_id: 'w9:p1',
            workspace_id: 'w9',
            tab_id: 'w9:t1',
            cwd: '/home/john/dev/active/session-minder',
            agent: 'claude',
            agent_session: {
              source: 'herdr:claude',
              agent: 'claude',
              kind: 'id',
              value: '8f7f70ae-9054-45b6-9f07-23e66f3a26b4',
            },
          },
        ],
      },
    }));

    const panes = await createHerdrClient(socketPath).listPanes();

    expect(panes).toHaveLength(1);
    expect(panes[0].agent_session?.value).toBe('8f7f70ae-9054-45b6-9f07-23e66f3a26b4');
  });

  it('throws HerdrUnreachableError when the socket does not exist', async () => {
    const client = createHerdrClient('/nonexistent/herdr.sock');

    // Pins the degrade contract: an absent Herdr must surface as one typed,
    // recognizable error the route can turn into a degrade response — not an
    // arbitrary ENOENT that reaches the client as a 500.
    await expect(client.listPanes()).rejects.toBeInstanceOf(HerdrUnreachableError);
  });

  it('throws HerdrUnreachableError when Herdr returns a protocol error', async () => {
    const { socketPath } = fakeHerdr(() => ({
      id: '',
      error: { code: 'invalid_request', message: 'unknown variant' },
    }));

    await expect(createHerdrClient(socketPath).listPanes()).rejects.toBeInstanceOf(
      HerdrUnreachableError
    );
  });

  it('sends pane.focus with the pane_id param', async () => {
    const { socketPath, received } = fakeHerdr(() => ({ id: '1', result: { type: 'ok' } }));

    await createHerdrClient(socketPath).focusPane('w9:p1');

    expect(received[0].method).toBe('pane.focus');
    expect(received[0].params).toEqual({ pane_id: 'w9:p1' });
  });

  it('creates a tab and returns the root pane id', async () => {
    const { socketPath, received } = fakeHerdr(() => ({
      id: '1',
      result: {
        type: 'tab_created',
        tab: { tab_id: 'w9:t2' },
        root_pane: { pane_id: 'w9:p3' },
      },
    }));

    const result = await createHerdrClient(socketPath).createTab({
      cwd: '/home/john/dev/wayfinder',
      label: 'resume',
    });

    // Pins the spawn handoff: agent.start needs a pane_id, and the ONLY
    // source of it is tab.create's root_pane. Reading the wrong field here
    // breaks the ended-branch with no test failure elsewhere.
    expect(result).toEqual({ paneId: 'w9:p3', tabId: 'w9:t2' });
    expect(received[0].params.cwd).toBe('/home/john/dev/wayfinder');
    expect(received[0].params.focus).toBe(true);
  });

  it('starts an agent with resume args', async () => {
    const { socketPath, received } = fakeHerdr(() => ({
      id: '1',
      result: { type: 'agent_started', agent: {}, argv: ['claude', '--resume', 'abc'] },
    }));

    const result = await createHerdrClient(socketPath).startAgent({
      paneId: 'w9:p3',
      kind: 'claude',
      name: 'session-minder resume',
      args: ['--resume', 'abc'],
    });

    expect(received[0].method).toBe('agent.start');
    expect(received[0].params).toMatchObject({
      pane_id: 'w9:p3',
      kind: 'claude',
      args: ['--resume', 'abc'],
    });
    expect(result.argv).toEqual(['claude', '--resume', 'abc']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/herdr.test.ts`
Expected: FAIL — `Failed to resolve import "../src/herdr.js"`.

- [ ] **Step 3: Implement the client**

Create `src/herdr.ts`:

```ts
// src/herdr.ts
// The only module that knows the Herdr wire protocol. Everything above this
// file speaks in HerdrPane objects, so dropping Herdr means replacing this
// file and the attach route's executor — not the DB contract (spec: Design
// guards, "keep the Herdr layer thin").
import net from 'node:net';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REQUEST_TIMEOUT_MS = 2000;

export interface HerdrAgentSession {
  source: string;
  agent: string;
  kind: string;
  value: string;
}

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd: string | null;
  agent: string | null;
  agent_session?: HerdrAgentSession;
}

// One error type for every "Herdr can't answer" case — socket missing, server
// down, timeout, or a protocol-level error response. The attach route turns
// exactly this into a degrade response; anything else is a genuine 500.
export class HerdrUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HerdrUnreachableError';
  }
}

export interface HerdrClient {
  listPanes(): Promise<HerdrPane[]>;
  focusPane(paneId: string): Promise<void>;
  createTab(opts: {
    cwd: string;
    workspaceId?: string;
    label?: string;
  }): Promise<{ paneId: string; tabId: string }>;
  startAgent(opts: {
    paneId: string;
    kind: string;
    name: string;
    args: string[];
  }): Promise<{ argv: string[] }>;
}

function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(new HerdrUnreachableError(message));
    };

    const timer = setTimeout(() => fail(`${method} timed out`), REQUEST_TIMEOUT_MS);

    conn.on('error', (err) => {
      clearTimeout(timer);
      fail(`${method} failed: ${err.message}`);
    });

    conn.on('connect', () => {
      // `id` MUST be a string — Herdr rejects an integer outright.
      conn.write(JSON.stringify({ id: '1', method, params }) + '\n');
    });

    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      let parsed: any;
      try {
        parsed = JSON.parse(buf.slice(0, idx));
      } catch {
        return fail(`${method} returned unparseable JSON`);
      }
      if (parsed.error) {
        return fail(`${method} error: ${parsed.error.code} ${parsed.error.message}`);
      }
      if (settled) return;
      settled = true;
      conn.end();
      resolve(parsed.result ?? {});
    });

    conn.on('close', () => fail(`${method} closed without a response`));
  });
}

export function createHerdrClient(socketPath: string): HerdrClient {
  return {
    async listPanes() {
      const result = await request(socketPath, 'pane.list', {});
      return (result.panes ?? []) as HerdrPane[];
    },
    async focusPane(paneId) {
      await request(socketPath, 'pane.focus', { pane_id: paneId });
    },
    async createTab({ cwd, workspaceId, label }) {
      const result = await request(socketPath, 'tab.create', {
        cwd,
        focus: true,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        ...(label ? { label } : {}),
      });
      const paneId = result.root_pane?.pane_id;
      const tabId = result.tab?.tab_id;
      if (!paneId || !tabId) {
        throw new HerdrUnreachableError('tab.create returned no root pane');
      }
      return { paneId, tabId };
    },
    async startAgent({ paneId, kind, name, args }) {
      const result = await request(socketPath, 'agent.start', {
        pane_id: paneId,
        kind,
        name,
        args,
      });
      return { argv: (result.argv ?? []) as string[] };
    },
  };
}

// session-minder runs as a systemd service, NOT inside a Herdr pane, so it has
// no HERDR_SOCKET_PATH of its own. Discovery beats configuration here: John
// renames his Herdr session as his layout evolves (herdr-lab -> herdr-4up), and
// a pinned path in the unit file would rot silently on the next rename.
export async function discoverHerdrSocket(): Promise<string | null> {
  const override = process.env.SESSION_MINDER_HERDR_SOCKET;
  if (override) return override;

  const base = join(homedir(), '.config', 'herdr');
  const candidates = [join(base, 'herdr.sock')];

  try {
    const names = await readdir(join(base, 'sessions'));
    for (const name of names) {
      candidates.push(join(base, 'sessions', name, 'herdr.sock'));
    }
  } catch {
    // No named sessions directory — the default socket is the only candidate.
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      await request(candidate, 'ping', {});
      return candidate;
    } catch {
      // Stale socket file or a stopped server; try the next candidate.
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/herdr.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify discovery works against the real Herdr server**

Run: `npx tsx -e "import('./src/herdr.ts').then(async m => console.log(await m.discoverHerdrSocket()))"`
Expected: prints a real path such as `/home/john/.config/herdr/sessions/herdr-4up/herdr.sock` (the session name will differ if the workspace has been renamed).

- [ ] **Step 6: Commit**

```bash
git add src/herdr.ts test/herdr.test.ts
git commit -m "feat(herdr): add socket client with session discovery"
```

---

## Task 4: Attach resolver

**Files:**
- Create: `src/attach.ts`
- Test: `test/attach.test.ts`

**Interfaces:**
- Consumes: `HerdrPane` from `src/herdr.ts` (Task 3).
- Produces, for Task 5:
  ```ts
  export interface SessionRow {
    id: string;
    platform: 'claude_code' | 'hermes' | 'kimi_code';
    external_session_id: string;
    host: string;
    project_path: string | null;
    ended_at: Date | null;
  }
  export type AttachPlan =
    | { kind: 'focus'; pane_id: string; workspace_id: string }
    | { kind: 'spawn'; cwd: string; agent_kind: string; args: string[]; command: string }
    | { kind: 'degrade'; reason: DegradeReason; command: string | null };
  export type DegradeReason =
    | 'herdr_unreachable' | 'foreign_host' | 'not_resumable_platform' | 'no_project_path';
  export function resolveAttach(input: {
    session: SessionRow;
    panes: HerdrPane[] | null;   // null == Herdr unreachable
    localHost: string;
  }): AttachPlan;
  ```

**Resume-command table.** Only `claude_code` gets a spawn branch in this phase. Hermes's CLI resume syntax has never been verified, and Kimi Code is not online — inventing either command would produce an endpoint that silently launches the wrong thing. Both degrade with `not_resumable_platform`, which is exactly the behavior the spec's degrade branch exists for.

- [ ] **Step 1: Write the failing tests**

Create `test/attach.test.ts`:

```ts
// test/attach.test.ts
import { describe, it, expect } from 'vitest';
import { resolveAttach, type SessionRow } from '../src/attach.js';
import type { HerdrPane } from '../src/herdr.js';

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 'row-uuid',
  platform: 'claude_code',
  external_session_id: 'abc-123',
  host: 'vps8-core',
  project_path: '/home/john/dev/wayfinder',
  ended_at: new Date(),
  ...over,
});

const pane = (over: Partial<HerdrPane> = {}): HerdrPane => ({
  pane_id: 'w9:p1',
  workspace_id: 'w9',
  tab_id: 'w9:t1',
  cwd: '/home/john/dev/wayfinder',
  agent: 'claude',
  agent_session: {
    source: 'herdr:claude',
    agent: 'claude',
    kind: 'id',
    value: 'abc-123',
  },
  ...over,
});

describe('resolveAttach', () => {
  it('focuses the live pane whose agent_session matches external_session_id', () => {
    const plan = resolveAttach({
      session: session(),
      panes: [pane()],
      localHost: 'vps8-core',
    });

    // Pins the join rule that the whole phase rests on: the match is on
    // agent_session.value == external_session_id, NOT on cwd or agent kind.
    expect(plan).toEqual({ kind: 'focus', pane_id: 'w9:p1', workspace_id: 'w9' });
  });

  it('does not match a pane whose cwd is right but whose session id differs', () => {
    const plan = resolveAttach({
      session: session(),
      panes: [pane({ agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: 'a-different-uuid' } })],
      localHost: 'vps8-core',
    });

    // Pins the negative half of the join rule. A cwd-based fallback would
    // focus the WRONG session — the failure this endpoint must never make.
    expect(plan.kind).toBe('spawn');
  });

  it('treats a pane with no agent_session as not live', () => {
    const plan = resolveAttach({
      session: session(),
      panes: [pane({ agent_session: undefined })],
      localHost: 'vps8-core',
    });

    // Pins the spike finding: panes whose agent started before the Herdr
    // integration was installed have no agent_session. That is "not live",
    // never an error.
    expect(plan.kind).toBe('spawn');
  });

  it('spawns a resume pane for an ended claude_code session', () => {
    const plan = resolveAttach({
      session: session(),
      panes: [],
      localHost: 'vps8-core',
    });

    expect(plan).toEqual({
      kind: 'spawn',
      cwd: '/home/john/dev/wayfinder',
      agent_kind: 'claude',
      args: ['--resume', 'abc-123'],
      command: 'claude --resume abc-123',
    });
  });

  it('degrades with herdr_unreachable when panes is null', () => {
    const plan = resolveAttach({
      session: session(),
      panes: null,
      localHost: 'vps8-core',
    });

    // Pins the fallback contract: even with Herdr gone, the caller still gets
    // a usable copyable command — the dashboard's v1 behavior survives.
    expect(plan).toEqual({
      kind: 'degrade',
      reason: 'herdr_unreachable',
      command: 'claude --resume abc-123',
    });
  });

  it('degrades for a session captured on another host', () => {
    const plan = resolveAttach({
      session: session({ host: 'mbp' }),
      panes: [pane()],
      localHost: 'vps8-core',
    });

    // Pins the server-locality guard: the Herdr socket is local, so a session
    // from mbp can never be attached here even if an id somehow matched.
    expect(plan).toEqual({
      kind: 'degrade',
      reason: 'foreign_host',
      command: 'claude --resume abc-123',
    });
  });

  it('degrades for a hermes session with no command', () => {
    const plan = resolveAttach({
      session: session({ platform: 'hermes' }),
      panes: [],
      localHost: 'vps8-core',
    });

    // Pins the deliberate omission: Hermes resume syntax is unverified, so
    // the endpoint must say "I don't know" rather than guess a command.
    expect(plan).toEqual({
      kind: 'degrade',
      reason: 'not_resumable_platform',
      command: null,
    });
  });

  it('degrades when an ended session has no project_path', () => {
    const plan = resolveAttach({
      session: session({ project_path: null }),
      panes: [],
      localHost: 'vps8-core',
    });

    // Pins the spawn precondition: tab.create requires a cwd. Many Hermes and
    // cron sessions have none.
    expect(plan).toEqual({
      kind: 'degrade',
      reason: 'no_project_path',
      command: 'claude --resume abc-123',
    });
  });

  it('focuses a live session even when it is captured on a foreign host? no — host wins', () => {
    const plan = resolveAttach({
      session: session({ host: 'mini' }),
      panes: [pane()],
      localHost: 'vps8-core',
    });

    // Ordering matters: the host guard is checked BEFORE the pane join, so a
    // stale id collision across machines can never focus a local pane.
    expect(plan.kind).toBe('degrade');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/attach.test.ts`
Expected: FAIL — `Failed to resolve import "../src/attach.js"`.

- [ ] **Step 3: Implement the resolver**

Create `src/attach.ts`:

```ts
// src/attach.ts
// Pure decision layer: no sockets, no database. Every branch rule from the
// spec's "2.a scope / Attach contract" lives here so it can be tested with
// plain objects.
import type { HerdrPane } from './herdr.js';

export type Platform = 'claude_code' | 'hermes' | 'kimi_code';

export interface SessionRow {
  id: string;
  platform: Platform;
  external_session_id: string;
  host: string;
  project_path: string | null;
  ended_at: Date | null;
}

export type DegradeReason =
  | 'herdr_unreachable'
  | 'foreign_host'
  | 'not_resumable_platform'
  | 'no_project_path';

export type AttachPlan =
  | { kind: 'focus'; pane_id: string; workspace_id: string }
  | { kind: 'spawn'; cwd: string; agent_kind: string; args: string[]; command: string }
  | { kind: 'degrade'; reason: DegradeReason; command: string | null };

// Only claude_code is resumable in Phase 2.a. Hermes's CLI resume syntax is
// unverified and Kimi Code is not online (spec: Open Question 2) — guessing
// either would produce an endpoint that confidently launches the wrong thing.
interface ResumeSpec {
  agentKind: string;
  args: (externalSessionId: string) => string[];
  command: (externalSessionId: string) => string;
}

const RESUME: Partial<Record<Platform, ResumeSpec>> = {
  claude_code: {
    agentKind: 'claude',
    args: (id) => ['--resume', id],
    command: (id) => `claude --resume ${id}`,
  },
};

export function resolveAttach(input: {
  session: SessionRow;
  panes: HerdrPane[] | null;
  localHost: string;
}): AttachPlan {
  const { session, panes, localHost } = input;
  const resume = RESUME[session.platform];
  const command = resume ? resume.command(session.external_session_id) : null;

  // Checked before the pane join on purpose: external_session_id is unique
  // per (platform, id) but two machines could in principle collide, and
  // focusing a local pane for a remote session would be a silent wrong answer.
  if (session.host !== localHost) {
    return { kind: 'degrade', reason: 'foreign_host', command };
  }

  if (panes === null) {
    return { kind: 'degrade', reason: 'herdr_unreachable', command };
  }

  const live = panes.find(
    (p) => p.agent_session?.value === session.external_session_id
  );
  if (live) {
    return { kind: 'focus', pane_id: live.pane_id, workspace_id: live.workspace_id };
  }

  if (!resume) {
    return { kind: 'degrade', reason: 'not_resumable_platform', command: null };
  }

  if (!session.project_path) {
    return { kind: 'degrade', reason: 'no_project_path', command };
  }

  return {
    kind: 'spawn',
    cwd: session.project_path,
    agent_kind: resume.agentKind,
    args: resume.args(session.external_session_id),
    command: resume.command(session.external_session_id),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/attach.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/attach.ts test/attach.test.ts
git commit -m "feat(attach): add pure resolver for live/ended/degrade branches"
```

---

## Task 5: Attach endpoint

**Files:**
- Create: `src/routes/attach.ts`
- Modify: `src/server.ts`
- Test: `test/attach-route.test.ts`

**Interfaces:**
- Consumes: `createHerdrClient`, `discoverHerdrSocket`, `HerdrUnreachableError`, `HerdrPane` (Task 3); `resolveAttach`, `SessionRow`, `AttachPlan` (Task 4); `getSql` (`src/db.ts`); `requireAuth` (`src/auth.ts`).
- Produces: `export function registerAttachRoute(app: FastifyInstance): void`, and the HTTP contract the Phase 2.b dashboard will call:

  | Outcome | Status | Body |
  |---|---|---|
  | Focused a live pane | 200 | `{"action":"focused","pane_id":"w9:p1","workspace_id":"w9"}` |
  | Spawned a resume pane | 200 | `{"action":"spawned","pane_id":"w9:p3","tab_id":"w9:t2","argv":[...]}` |
  | Degraded | 200 | `{"action":"degraded","reason":"herdr_unreachable","command":"claude --resume abc"}` |
  | Unknown session id | 404 | `{"error":"not found"}` |
  | Bad uuid | 400 | `{"error":"invalid id"}` |

  Degrade is a **200, not an error** — it is a successful answer to "how do I get back in", just not an automated one.

- [ ] **Step 1: Write the failing tests**

Create `test/attach-route.test.ts`:

```ts
// test/attach-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql, mockClient, mockDiscover } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockClient: {
    listPanes: vi.fn(),
    focusPane: vi.fn(),
    createTab: vi.fn(),
    startAgent: vi.fn(),
  },
  mockDiscover: vi.fn(),
}));

vi.mock('../src/db.js', () => ({ getSql: () => mockSql }));
vi.mock('../src/herdr.js', async () => {
  const actual = await vi.importActual<typeof import('../src/herdr.js')>('../src/herdr.js');
  return {
    ...actual,
    createHerdrClient: () => mockClient,
    discoverHerdrSocket: mockDiscover,
  };
});

const { buildServer } = await import('../src/server.js');

const SESSION_UUID = '11111111-2222-3333-4444-555555555555';

const row = (over: Record<string, unknown> = {}) => ({
  id: SESSION_UUID,
  platform: 'claude_code',
  external_session_id: 'abc-123',
  host: 'vps8-core',
  project_path: '/home/john/dev/wayfinder',
  ended_at: new Date(),
  ...over,
});

const post = (id = SESSION_UUID) =>
  buildServer().inject({
    method: 'POST',
    url: `/api/sessions/${id}/attach`,
    headers: { authorization: 'Bearer test-token-123' },
  });

describe('POST /api/sessions/:id/attach', () => {
  beforeEach(() => {
    mockSql.mockReset();
    Object.values(mockClient).forEach((fn) => fn.mockReset());
    mockDiscover.mockReset();
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
    process.env.SESSION_MINDER_HOST_NAME = 'vps8-core';
  });

  it('rejects requests without a valid bearer token', async () => {
    const res = await buildServer().inject({
      method: 'POST',
      url: `/api/sessions/${SESSION_UUID}/attach`,
    });
    expect(res.statusCode).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown session', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await post();
    expect(res.statusCode).toBe(404);
  });

  it('focuses the pane and reports action=focused', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([
      {
        pane_id: 'w9:p1',
        workspace_id: 'w9',
        tab_id: 'w9:t1',
        cwd: '/home/john/dev/wayfinder',
        agent: 'claude',
        agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: 'abc-123' },
      },
    ]);

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ action: 'focused', pane_id: 'w9:p1', workspace_id: 'w9' });
    // Pins that focus actually happened. Returning the plan without executing
    // it would satisfy a body-shape assertion while doing nothing.
    expect(mockClient.focusPane).toHaveBeenCalledWith('w9:p1');
    expect(mockClient.createTab).not.toHaveBeenCalled();
  });

  it('spawns a tab and starts the agent for an ended session', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([]);
    mockClient.createTab.mockResolvedValueOnce({ paneId: 'w9:p3', tabId: 'w9:t2' });
    mockClient.startAgent.mockResolvedValueOnce({ argv: ['claude', '--resume', 'abc-123'] });

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      action: 'spawned',
      pane_id: 'w9:p3',
      tab_id: 'w9:t2',
      argv: ['claude', '--resume', 'abc-123'],
    });
    // Pins the ordering and the cwd: the agent must start in the pane the tab
    // just created, in the session's own project directory.
    expect(mockClient.createTab).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/home/john/dev/wayfinder' })
    );
    expect(mockClient.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'w9:p3', kind: 'claude', args: ['--resume', 'abc-123'] })
    );
  });

  it('degrades with 200 and a copyable command when Herdr is not running', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce(null);

    const res = await post();

    // Pins that degrade is a SUCCESS, not an error. A 5xx here would make the
    // dashboard show a failure for a session the user can still resume by hand.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      action: 'degraded',
      reason: 'herdr_unreachable',
      command: 'claude --resume abc-123',
    });
  });

  it('degrades when a Herdr call throws mid-flight', async () => {
    const { HerdrUnreachableError } = await import('../src/herdr.js');
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockRejectedValueOnce(new HerdrUnreachableError('socket died'));

    const res = await post();

    // Pins the race: Herdr can stop between discovery and the call.
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('degraded');
    expect(res.json().reason).toBe('herdr_unreachable');
  });

  it('rejects a non-uuid id without touching the database', async () => {
    const res = await post('not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/attach-route.test.ts`
Expected: FAIL — `Failed to resolve import "../src/routes/attach.js"` (once registered) or 404 on every request.

- [ ] **Step 3: Implement the route**

Create `src/routes/attach.ts`:

```ts
// src/routes/attach.ts
import type { FastifyInstance } from 'fastify';
import { hostname } from 'node:os';
import { getSql } from '../db.js';
import { requireAuth } from '../auth.js';
import { resolveAttach, type SessionRow } from '../attach.js';
import {
  createHerdrClient,
  discoverHerdrSocket,
  HerdrUnreachableError,
  type HerdrPane,
} from '../herdr.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The hooks record `host` as the Tailscale short name (vps8-core), not the
// provider hostname (srv1086450), so the comparison must use the same name.
// SESSION_MINDER_HOST_NAME is set in the systemd unit; hostname() is only a
// last-resort fallback and will simply degrade if it disagrees.
function localHost(): string {
  return process.env.SESSION_MINDER_HOST_NAME ?? hostname();
}

export function registerAttachRoute(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/attach',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        reply.code(400).send({ error: 'invalid id' });
        return;
      }

      const sql = getSql();
      const [session] = await sql<SessionRow[]>`
        SELECT id, platform, external_session_id, host, project_path, ended_at
        FROM _sessionminder.sessions
        WHERE id = ${id}
      `;
      if (!session) {
        reply.code(404).send({ error: 'not found' });
        return;
      }

      const socketPath = await discoverHerdrSocket();
      const client = socketPath ? createHerdrClient(socketPath) : null;

      let panes: HerdrPane[] | null = null;
      if (client) {
        try {
          panes = await client.listPanes();
        } catch (err) {
          if (!(err instanceof HerdrUnreachableError)) throw err;
          panes = null;
        }
      }

      const plan = resolveAttach({ session, panes, localHost: localHost() });

      try {
        if (plan.kind === 'focus') {
          await client!.focusPane(plan.pane_id);
          reply.send({
            action: 'focused',
            pane_id: plan.pane_id,
            workspace_id: plan.workspace_id,
          });
          return;
        }

        if (plan.kind === 'spawn') {
          const tab = await client!.createTab({
            cwd: plan.cwd,
            label: 'resume',
          });
          const started = await client!.startAgent({
            paneId: tab.paneId,
            kind: plan.agent_kind,
            name: 'session-minder resume',
            args: plan.args,
          });
          reply.send({
            action: 'spawned',
            pane_id: tab.paneId,
            tab_id: tab.tabId,
            argv: started.argv,
          });
          return;
        }
      } catch (err) {
        // Herdr can stop between listPanes() and the action. Fall through to
        // the degrade answer rather than failing a request the user can still
        // satisfy by copying the command.
        if (!(err instanceof HerdrUnreachableError)) throw err;
        const fallback = resolveAttach({
          session,
          panes: null,
          localHost: localHost(),
        });
        reply.send({ action: 'degraded', ...stripKind(fallback) });
        return;
      }

      reply.send({ action: 'degraded', ...stripKind(plan) });
    }
  );
}

function stripKind(plan: { kind: string } & Record<string, unknown>) {
  const { kind: _kind, ...rest } = plan;
  return rest;
}
```

- [ ] **Step 4: Register the route**

In `src/server.ts`, add the import and the registration:

```ts
// src/server.ts
import Fastify, { FastifyInstance } from 'fastify';
import { registerCaptureRoute } from './routes/capture.js';
import { registerAttachRoute } from './routes/attach.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.get('/healthz', async () => ({ ok: true }));
  registerCaptureRoute(app);
  registerAttachRoute(app);

  return app;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/attach-route.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/routes/attach.ts src/server.ts test/attach-route.test.ts
git commit -m "feat(attach): add POST /api/sessions/:id/attach endpoint"
```

---

## Task 6: Deploy, verify live, and record

**Files:**
- Modify: `deploy/session-minder.service`
- Modify: `.env.example`
- Modify: `.docs/status.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a verified running system and an accurate status doc.

- [ ] **Step 1: Add the host-name variable to the systemd unit**

`src/routes/attach.ts` compares `session.host` against `SESSION_MINDER_HOST_NAME`. Without it, `hostname()` returns `srv1086450` while every captured row says `vps8-core`, and **every attach silently degrades with `foreign_host`** — a failure that looks like "Herdr isn't working."

Add to the `[Service]` section of `deploy/session-minder.service`, beside the existing `Environment=` lines:

```
Environment=SESSION_MINDER_HOST_NAME=vps8-core
```

Add to `.env.example`:

```
# Tailscale short name of the host this service runs on. Must match the `host`
# value the hook scripts record, or every attach degrades with foreign_host.
SESSION_MINDER_HOST_NAME=vps8-core
# Optional: pin the Herdr socket instead of discovering it.
# SESSION_MINDER_HERDR_SOCKET=/home/john/.config/herdr/sessions/herdr-4up/herdr.sock
```

- [ ] **Step 2: Restart the service (John runs this — it needs sudo)**

```bash
sudo systemctl daemon-reload
sudo systemctl restart session-minder
systemctl is-active session-minder
curl -s http://vps8-core:3000/healthz
```

Expected: `active`, then `{"ok":true}`.

- [ ] **Step 3: Verify the live branch against this very session**

From a Claude Code session running in a Herdr pane, get its row id and attach to itself:

```bash
set -a; . ./.env.local; set +a
ROW=$(psql "$DATABASE_URL" -tAc "SELECT id FROM _sessionminder.sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1;")
curl -s -X POST "http://vps8-core:3000/api/sessions/$ROW/attach" \
  -H "Authorization: Bearer $SESSION_MINDER_TOKEN" | jq
```

Expected: `{"action":"focused","pane_id":"w#:p#","workspace_id":"w#"}` **and** the Herdr TUI visibly jumps to that pane.

- [ ] **Step 4: Verify the ended branch**

Pick an ended `claude_code` session that has a `project_path`:

```bash
ROW=$(psql "$DATABASE_URL" -tAc "SELECT id FROM _sessionminder.sessions WHERE platform='claude_code' AND ended_at IS NOT NULL AND project_path IS NOT NULL AND noise_flag = false ORDER BY started_at DESC LIMIT 1;")
curl -s -X POST "http://vps8-core:3000/api/sessions/$ROW/attach" \
  -H "Authorization: Bearer $SESSION_MINDER_TOKEN" | jq
```

Expected: `{"action":"spawned",...}` and a new Herdr tab appears running `claude --resume <uuid>` in the right directory, with the prior conversation loaded.

**If this misbehaves, stop and report rather than iterating.** It is the one branch that mutates John's live workspace.

- [ ] **Step 5: Verify the degrade branch**

```bash
ROW=$(psql "$DATABASE_URL" -tAc "SELECT id FROM _sessionminder.sessions WHERE platform='hermes' ORDER BY started_at DESC LIMIT 1;")
curl -s -X POST "http://vps8-core:3000/api/sessions/$ROW/attach" \
  -H "Authorization: Bearer $SESSION_MINDER_TOKEN" | jq
```

Expected: `{"action":"degraded","reason":"not_resumable_platform","command":null}`.

- [ ] **Step 6: Update `.docs/status.md`**

Rewrite the "What's next?" section to state that Phase 2.a is shipped, that the attach contract exists at `POST /api/sessions/:id/attach` with its three actions, and that Phase 2.b (the dashboard) is now the next conversation with no remaining gate. Record the two knowing omissions: Hermes/Kimi resume commands are unverified and degrade by design, and Kimi hooks were not given Herdr enrichment.

- [ ] **Step 7: Commit**

```bash
git add deploy/session-minder.service .env.example .docs/status.md
git commit -m "chore: deploy Phase 2.a attach layer and record verification"
```

---

## Self-Review

**Spec coverage.** 2.a scope step 1 (spike) — already done, recorded in the spec, not a task here. Step 2 (capture enrichment into `raw_metadata.herdr`, no schema change) — Tasks 1–2. Step 3 (attach contract, three branches) — Tasks 3–5. Design guards: thin layer behind session-minder's API (only `src/herdr.ts` and the route executor know Herdr); no persistent listener (one-shot connections, no `events.subscribe`); server locality (the `foreign_host` degrade). Testing section: "integration tests for the attach endpoint's three branches with the Herdr socket faked" — Task 5; "the spike itself is manual verification against a real Herdr server" — Task 6.

**Deliberate omissions, all flagged in-plan rather than silently dropped:**
1. Kimi Code hooks get no Herdr enrichment (Kimi is not online; unverifiable).
2. Hermes and Kimi have no resume command — they degrade with `not_resumable_platform` rather than a guessed command.
3. Live-status badges are Phase 2.b; this phase exposes the join, not a list endpoint.

**Type consistency.** `HerdrPane` / `HerdrAgentSession` / `HerdrUnreachableError` / `createHerdrClient` / `discoverHerdrSocket` are defined in Task 3 and used with those exact names in Tasks 4 and 5. `SessionRow` and `resolveAttach` are defined in Task 4 and consumed in Task 5. `AttachPlan.kind` values (`focus` / `spawn` / `degrade`) map to response `action` values (`focused` / `spawned` / `degraded`) — deliberately different words, converted only in the route.

**Open risk to watch during execution.** `agent.start`'s `args` were verified to exist in the schema but never executed against a live server. If Step 4 of Task 6 shows Herdr ignoring `args` or launching a fresh session instead of resuming, the fallback is `pane.send_text` with the full command line — a small change confined to `src/herdr.ts` and the route's spawn branch.
