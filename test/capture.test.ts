// test/capture.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above top-level const declarations, so the
// mock must come from vi.hoisted() — a plain `const mockSql = vi.fn()` here
// would throw "Cannot access 'mockSql' before initialization".
const { mockSql } = vi.hoisted(() => {
  const fn = vi.fn() as any;
  // Real postgres.js sql.json() wraps the value in Parameter{value, type: 3802}.
  // The mock unwraps to identity so assertions read the plain object directly.
  fn.json = (v: unknown) => v;
  return { mockSql: fn };
});
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
    expect(mockSql).not.toHaveBeenCalled();
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

    // Pin the idempotent-insert behavior itself, not just "some query ran":
    // mockSql is invoked as a tagged template, so calls[0][0] is the
    // template-strings array and calls[0].slice(1) is the interpolated
    // values in order.
    const [strings, ...values] = mockSql.mock.calls[0];
    expect(strings.join('?')).toMatch(
      /ON CONFLICT \(platform, external_session_id\) DO NOTHING/
    );
    expect(values).toEqual([
      'claude_code',
      'abc-123',
      'mbp',
      '/home/john/dev/active/session-minder',
      {},
    ]);
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

  it('rejects an otherwise-valid payload with an unrecognized platform', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: {
        platform: 'not-a-real-platform',
        external_session_id: 'abc-123',
        event: 'start',
        host: 'mbp',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

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
});

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

    // The started_at SELECT resolved to [] above, so `existing` is
    // undefined, durationSeconds is null, and the missed-start path in
    // isNoise must not flag this as noise (null duration → noise_flag
    // false), regardless of message_count.
    const [, ...upsertValues] = mockSql.mock.calls[1];
    expect(upsertValues).toEqual([
      'hermes',
      'xyz-789',
      'vps8-core',
      1,
      false,
      {}, // VALUES clause raw_metadata
      1,
      false,
      {}, // SET clause raw_metadata
    ]);
  });

  it('sends the started_at SELECT as the first query', async () => {
    mockSql.mockResolvedValue([]);

    const app = buildServer();
    await app.inject({
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

    const [strings, ...values] = mockSql.mock.calls[0];
    expect(strings.join('?')).toMatch(
      /SELECT started_at FROM _sessionminder\.sessions/
    );
    expect(values).toEqual(['hermes', 'xyz-789']);
  });

  it('upserts via ON CONFLICT ... DO UPDATE without touching started_at, and computes noise_flag from duration', async () => {
    // A fixed, explicit started_at well outside the noise window (120s ago),
    // captured once so the test isn't sensitive to real-clock timing.
    const fixedNow = Date.now();
    const startedAt = new Date(fixedNow - 120_000);
    mockSql.mockResolvedValueOnce([{ started_at: startedAt }]); // SELECT
    mockSql.mockResolvedValueOnce([]); // UPSERT

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: {
        platform: 'hermes',
        external_session_id: 'not-noise',
        event: 'end',
        host: 'vps8-core',
        message_count: 5,
      },
    });

    expect(res.statusCode).toBe(204);

    const [strings, ...values] = mockSql.mock.calls[1];
    const joined = strings.join('?');
    expect(joined).toMatch(
      /ON CONFLICT \(platform, external_session_id\) DO UPDATE/
    );
    // The SET clause must not reassign started_at — only the text after
    // "DO UPDATE" is the SET clause, so isolate it before asserting.
    const setClause = joined.split('DO UPDATE')[1];
    expect(setClause).not.toMatch(/started_at/);
    // message_count must be COALESCEd against the existing row, not
    // overwritten unconditionally — an end event without a count (no hook
    // sends one today) must not erase a count an earlier event recorded.
    // The interpolated value is identical either way, so only the SQL text
    // can distinguish this from a plain assignment.
    expect(setClause).toMatch(
      /message_count = COALESCE\(\?, _sessionminder\.sessions\.message_count\)/
    );

    expect(values).toEqual([
      'hermes',
      'not-noise',
      'vps8-core',
      5,
      false,
      {}, // VALUES clause raw_metadata
      5,
      false,
      {}, // SET clause raw_metadata
    ]);
  });

  it('flags noise_flag = true for a short session even when message_count is null (Hermes case)', async () => {
    // Fixed, explicit started_at 10s before a captured "now" — well inside
    // the noise window and not derived from clock timing during the test.
    const fixedNow = Date.now();
    const startedAt = new Date(fixedNow - 10_000);
    mockSql.mockResolvedValueOnce([{ started_at: startedAt }]); // SELECT
    mockSql.mockResolvedValueOnce([]); // UPSERT

    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/capture',
      headers: { authorization: 'Bearer test-token-123' },
      payload: {
        platform: 'hermes',
        external_session_id: 'noisy-1',
        event: 'end',
        host: 'vps8-core',
        // message_count intentionally omitted — no platform's end-hook
        // payload reliably carries one, and this must not veto the flag.
      },
    });

    expect(res.statusCode).toBe(204);

    const [, ...values] = mockSql.mock.calls[1];
    expect(values).toEqual([
      'hermes',
      'noisy-1',
      'vps8-core',
      null,
      true,
      {}, // VALUES clause raw_metadata
      null,
      true,
      {}, // SET clause raw_metadata
    ]);
  });

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
});
