// test/sessions-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql, mockClient, mockDiscover } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockClient: {
    listPanes: vi.fn(),
    focusPane: vi.fn(),
    createTab: vi.fn(),
    startAgent: vi.fn(),
    closeTab: vi.fn(),
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

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  platform: 'claude_code',
  title: null,
  project_path: '/home/john/dev/wayfinder',
  host: 'vps8-core',
  started_at: new Date('2026-08-10T09:00:00Z'),
  ended_at: new Date('2026-08-10T10:00:00Z'),
  message_count: 42,
  hermes_surface: null,
  external_session_id: 'abc-123',
  ...over,
});

const get = (query = '') =>
  buildServer().inject({
    method: 'GET',
    url: `/api/sessions${query}`,
    headers: { authorization: 'Bearer test-token-123' },
  });

// mockSql executes nothing, so the ONLY way to pin the SQL is to read what the
// tagged template was called with: the literal chunks and the interpolated
// values. `strings.join('?')` reconstructs the query text with parameter holes.
const call = (n = 0) => {
  const [strings, ...values] = mockSql.mock.calls[n];
  return { text: (strings as string[]).join('?'), values };
};

describe('GET /api/sessions', () => {
  beforeEach(() => {
    mockSql.mockReset();
    Object.values(mockClient).forEach((fn) => fn.mockReset());
    mockDiscover.mockReset();
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
    process.env.SESSION_MINDER_HOST_NAME = 'vps8-core';
    // Default happy path: no Herdr, one row, nothing hidden. Individual tests
    // override with their own mockResolvedValueOnce before the request.
    mockDiscover.mockResolvedValue(null);
  });

  it('rejects requests without a valid bearer token', async () => {
    const res = await buildServer().inject({ method: 'GET', url: '/api/sessions' });

    // The list exposes project paths and titles across every session on the
    // machine. An unauthenticated read is a disclosure, not an inconvenience.
    expect(res.statusCode).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('excludes noise and pruned rows, orders by recency, and limits to 15 by default', async () => {
    mockSql.mockResolvedValueOnce([dbRow()]).mockResolvedValueOnce([{ count: 18 }]);

    const res = await get();

    expect(res.statusCode).toBe(200);
    const { text, values } = call(0);
    // Four independent clauses, each droppable on its own — so each is
    // asserted on its own. Dropping the noise filter shows John 18 rows he
    // told the system to hide; dropping the pruned filter resurrects rows
    // curation removed; ASC puts his oldest session at row 1 (the whole point
    // of recency ordering is that "row 1 is what I was just doing"); no LIMIT
    // turns a one-glance list into a scrollback dump.
    expect(text).toMatch(/noise_flag/);
    expect(text).toMatch(/status\s*<>\s*'pruned'/);
    expect(text).toMatch(/ORDER BY\s+started_at\s+DESC/i);
    expect(text).toMatch(/LIMIT/i);
    // The parameters carry the actual behavior: noise excluded, no text
    // filter, 15 rows. Asserting the text alone would survive a mutant that
    // keeps the clause and inverts the value.
    expect(values).toEqual([false, null, null, null, null, 15]);
    expect(res.json().noise_hidden).toBe(18);
  });

  it('filters q across title, project_path and platform as parameters', async () => {
    mockSql.mockResolvedValueOnce([dbRow()]).mockResolvedValueOnce([{ count: 0 }]);

    await get('?q=jazz');

    const { text, values } = call(0);
    // All three columns, not just project_path: John filters by tool name
    // ("sm kimi") and by title as readily as by directory. title and
    // project_path are nullable, so they must be COALESCEd — a bare
    // `title ILIKE ?` is NULL for every untitled row, and NULL is not true,
    // so filtering would silently drop exactly the rows that need finding.
    expect(text).toMatch(/COALESCE\(title, ''\)\s+ILIKE/i);
    expect(text).toMatch(/COALESCE\(project_path, ''\)\s+ILIKE/i);
    expect(text).toMatch(/platform\s+ILIKE/i);
    // Parameterized, never concatenated. The literal must NOT appear in the
    // query text — if it does, the value reached SQL as text and `sm '%' OR
    // 1=1 --` is a live injection against John's own database.
    expect(text).not.toMatch(/jazz/);
    expect(values).toContain('%jazz%');
  });

  it('includes noise rows and reports zero hidden when noise=true', async () => {
    mockSql.mockResolvedValueOnce([dbRow()]);

    const res = await get('?noise=true');

    // The escape hatch behind `sm --all`. Ignoring the param would leave John
    // with no way to recover a misflagged session, and no window for judging
    // the noise thresholds — which is half of why the flag exists.
    expect(call(0).values[0]).toBe(true);
    expect(res.json().noise_hidden).toBe(0);
  });

  it('clamps limit to 100 and falls back to 15 for a non-numeric value', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);
    await get('?limit=500');
    expect(call(0).values.at(-1)).toBe(100);

    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);
    await get('?limit=abc');
    // Passing the raw value through sends `NaN` (or 500) into LIMIT: one
    // errors at the database, the other lets a caller pull the whole table.
    expect(call(0).values.at(-1)).toBe(15);
  });

  it('marks a row live only when a pane reports its external_session_id', async () => {
    mockSql
      .mockResolvedValueOnce([
        dbRow({ id: 'aaaa1111-0000-0000-0000-000000000000', external_session_id: 'live-one' }),
        dbRow({
          id: 'bbbb2222-0000-0000-0000-000000000000',
          external_session_id: 'not-in-a-pane',
          // Still running by the clock, but in no pane Herdr can see. If
          // liveness were computed from ended_at this row would be badged
          // live and picking it would spawn a duplicate instead of jumping.
          ended_at: null,
        }),
      ])
      .mockResolvedValueOnce([{ count: 0 }]);
    mockDiscover.mockResolvedValue('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([
      {
        pane_id: 'w9:p1',
        workspace_id: 'w9',
        tab_id: 'w9:t1',
        agent: 'claude',
        agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: 'live-one' },
      },
    ]);

    const res = await get();
    const [first, second] = res.json().sessions;

    // The join key is agent_session.value and nothing else — the same key the
    // attach route focuses on. 2.a settled this explicitly: live is a pane
    // match, not `ended_at IS NULL`.
    expect(first.live).toBe(true);
    expect(second.live).toBe(false);
    expect(res.json().herdr).toBe('ok');
    // external_session_id is a join key, not display data. Leaking it would
    // put raw ids in a list the spec says shows no ids at all.
    expect(first.external_session_id).toBeUndefined();
  });

  it('still returns sessions with live:null when Herdr cannot answer', async () => {
    mockSql.mockResolvedValueOnce([dbRow()]).mockResolvedValueOnce([{ count: 0 }]);
    mockDiscover.mockResolvedValue(null);

    const res = await get();

    // Sessions live in Postgres, not Herdr. Failing the list because liveness
    // can't be computed would make `sm` useless exactly when John most needs
    // the fallback command.
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toHaveLength(1);
    expect(res.json().sessions[0].live).toBeNull();
    expect(res.json().herdr).toBe('unreachable');
  });

  it('reports herdr:rejected distinctly when listPanes is refused', async () => {
    const { HerdrRejectedError } = await import('../src/herdr.js');
    mockSql.mockResolvedValueOnce([dbRow()]).mockResolvedValueOnce([{ count: 0 }]);
    mockDiscover.mockResolvedValue('/tmp/herdr.sock');
    mockClient.listPanes.mockRejectedValueOnce(
      new HerdrRejectedError('invalid_request', 'unknown variant', 'pane.list')
    );

    const res = await get();

    // Task 1's split, visible in the list too: "Herdr refused" and "Herdr is
    // down" are different facts and the picker warns differently about each.
    expect(res.statusCode).toBe(200);
    expect(res.json().herdr).toBe('rejected');
    expect(res.json().sessions[0].live).toBeNull();
  });

  it('flags foreign rows against SESSION_MINDER_HOST_NAME, not the machine hostname', async () => {
    process.env.SESSION_MINDER_HOST_NAME = 'vps8-core';
    mockSql
      .mockResolvedValueOnce([
        dbRow({ id: 'aaaa1111-0000-0000-0000-000000000000', host: 'vps8-core' }),
        dbRow({ id: 'bbbb2222-0000-0000-0000-000000000000', host: 'mbp' }),
      ])
      .mockResolvedValueOnce([{ count: 0 }]);

    const res = await get();
    const [local, remote] = res.json().sessions;

    // vps8's real hostname is the provider-assigned `srv1086450`; every hook
    // records `vps8-core`. Comparing against os.hostname() would tag EVERY row
    // foreign — 2.a's every-attach-degrades bug, reappearing as a display lie
    // ("[srv1086450]" on every line) rather than a failed attach.
    expect(local.foreign).toBe(false);
    expect(remote.foreign).toBe(true);
    expect(remote.host).toBe('mbp');
  });
});
