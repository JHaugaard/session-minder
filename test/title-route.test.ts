// test/title-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSql } = vi.hoisted(() => ({ mockSql: vi.fn() }));
vi.mock('../src/db.js', () => ({ getSql: () => mockSql }));

const { buildServer } = await import('../src/server.js');

const put = (body: unknown, auth = true) =>
  buildServer().inject({
    method: 'PUT',
    url: '/api/sessions/title',
    ...(auth ? { headers: { authorization: 'Bearer test-token-123' } } : {}),
    payload: body as any,
  });

const valid = (over: Record<string, unknown> = {}) => ({
  platform: 'claude_code',
  external_session_id: 'e22c3939-2671-4459-a22a-5f4d6c1dbe18',
  title: 'phase2b-picker',
  ...over,
});

// mockSql executes nothing, so the SQL is pinned by reading what the tagged
// template was called with: literal chunks plus interpolated values.
const call = (n = 0) => {
  const [strings, ...values] = mockSql.mock.calls[n];
  return { text: (strings as string[]).join('?'), values };
};

const updated = [{ id: 'row-uuid', title: 'phase2b-picker' }];

describe('PUT /api/sessions/title', () => {
  beforeEach(() => {
    mockSql.mockReset();
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
  });

  it('rejects requests without a valid bearer token', async () => {
    const res = await put(valid(), false);
    expect(res.statusCode).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('matches on BOTH platform and external_session_id', async () => {
    mockSql.mockResolvedValueOnce(updated);

    const res = await put(valid());

    expect(res.statusCode).toBe(200);
    const { text, values } = call();
    // The table's unique key is the PAIR. Matching on external_session_id
    // alone would be a latent cross-platform mislabel — and more immediately,
    // it stops expressing the constraint the row is actually identified by.
    expect(text).toMatch(/platform\s*=/);
    expect(text).toMatch(/external_session_id\s*=/);
    expect(values).toContain('claude_code');
    expect(values).toContain('e22c3939-2671-4459-a22a-5f4d6c1dbe18');
  });

  it('overwrites an existing title rather than keeping the first one', async () => {
    mockSql.mockResolvedValueOnce(updated);

    await put(valid({ title: 'renamed' }));

    const { text, values } = call();
    // John's ruling, 2026-08-11: re-titling replaces. A COALESCE(title, ...)
    // "keep first" would make every correction a silent no-op — the tool would
    // report success and the picker would keep showing the wrong name.
    expect(text).not.toMatch(/COALESCE\(\s*title/i);
    expect(values).toContain('renamed');
  });

  it('sets note when given and leaves an existing note alone when omitted', async () => {
    mockSql.mockResolvedValueOnce(updated);
    await put(valid({ note: 'the long summary paragraph' }));
    expect(call().values).toContain('the long summary paragraph');

    mockSql.mockReset();
    mockSql.mockResolvedValueOnce(updated);
    await put(valid());
    // Omitting note must not erase one. An unconditional `note = ${note}`
    // would null out the paragraph every time a title is corrected.
    expect(call().text).toMatch(/COALESCE\(/i);
    expect(call().values).toContain(null);
  });

  it('returns 404 without inventing a row when nothing matched', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await put(valid({ external_session_id: 'never-captured' }));

    // An upsert here would create a session with no capture data — a ghost row
    // that then shows up in `sm` as a resumable session that never existed.
    expect(res.statusCode).toBe(404);
    expect(call().text).not.toMatch(/INSERT/i);
    expect(call().text).toMatch(/UPDATE/i);
  });

  it('rejects an empty or whitespace-only title without touching the database', async () => {
    for (const title of ['', '   ']) {
      mockSql.mockReset();
      const res = await put(valid({ title }));
      // An empty title makes the picker fall back to the folder name, which
      // reads exactly like the titling silently failed.
      expect(res.statusCode).toBe(400);
      expect(mockSql).not.toHaveBeenCalled();
    }
  });

  it('rejects an over-long title instead of truncating it', async () => {
    const res = await put(valid({ title: 'x'.repeat(61) }));

    // Truncation would surprise: you would name a session and the picker would
    // show something you did not write. Rejecting names the limit instead.
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/60/);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects an unknown platform', async () => {
    const res = await put(valid({ platform: 'emacs' }));
    // The column has a CHECK constraint; catching it here gives a useful 400
    // instead of a 500 from Postgres.
    expect(res.statusCode).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from the stored title', async () => {
    mockSql.mockResolvedValueOnce(updated);
    await put(valid({ title: '  spaced  ' }));
    expect(call().values).toContain('spaced');
  });

  it('reports the row it updated', async () => {
    mockSql.mockResolvedValueOnce(updated);
    const res = await put(valid());
    expect(res.json()).toEqual({ id: 'row-uuid', title: 'phase2b-picker' });
  });
});
