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
});
