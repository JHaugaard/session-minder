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
    expect(res.json()).toEqual({ error: 'not found' });
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
    expect(res.json()).toEqual({ error: 'invalid id' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('does not degrade when listPanes fails with a non-Herdr error', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockRejectedValueOnce(new TypeError('bug in the client'));

    const res = await post();

    // Pins the error-class rule, not just "some response came back". ONLY
    // HerdrUnreachableError may degrade. Swallowing every error would report
    // a real bug to the dashboard as a successful 200 degrade — verified by
    // mutation: deleting the instanceof guard passes the whole rest of the suite.
    expect(res.statusCode).toBe(500);
    expect(res.json().action).toBeUndefined();
  });

  it('does not degrade when a spawn call fails with a non-Herdr error', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([]);
    mockClient.createTab.mockRejectedValueOnce(new TypeError('bug in the client'));

    // Pins the second guard independently. The two catch sites are separate
    // code paths and a fix to one does not protect the other.
    const res = await post();

    expect(res.statusCode).toBe(500);
    expect(res.json().action).toBeUndefined();
  });

  it('degrades with a command when focusPane fails mid-flight', async () => {
    const { HerdrUnreachableError } = await import('../src/herdr.js');
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([
      { pane_id: 'w9:p1', workspace_id: 'w9', tab_id: 'w9:t1', cwd: '/home/john/dev/wayfinder',
        agent: 'claude',
        agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: 'abc-123' } },
    ]);
    mockClient.focusPane.mockRejectedValueOnce(new HerdrUnreachableError('socket died'));

    const res = await post();

    // Pins RACE 2 — Herdr dying between listPanes() and the action. Test 6 covers
    // race 1 only. Asserting `command` too is what stops the fallback being
    // hard-coded to null: it must be re-derived through resolveAttach.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      action: 'degraded',
      reason: 'herdr_unreachable',
      command: 'claude --resume abc-123',
    });
  });

  it('degrades with a command when startAgent fails mid-flight', async () => {
    const { HerdrUnreachableError } = await import('../src/herdr.js');
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([]);
    mockClient.createTab.mockResolvedValueOnce({ paneId: 'w9:p3', tabId: 'w9:t2' });
    mockClient.startAgent.mockRejectedValueOnce(new HerdrUnreachableError('socket died'));

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('degraded');
    expect(res.json().command).toBe('claude --resume abc-123');
  });

  it('degrades for a session captured on another host without touching Herdr', async () => {
    mockSql.mockResolvedValueOnce([row({ host: 'mbp' })]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([]);

    const res = await post();

    // Pins that the ROUTE feeds resolveAttach the LOCAL host, not the row's own
    // host. With `localHost: session.host` the guard can never fire and a remote
    // session would be spawned on this machine. The resolver's own unit tests
    // cannot see this — they never exercise the route's wiring.
    expect(res.json()).toEqual({
      action: 'degraded',
      reason: 'foreign_host',
      command: 'claude --resume abc-123',
    });
    expect(mockClient.focusPane).not.toHaveBeenCalled();
    expect(mockClient.createTab).not.toHaveBeenCalled();
  });
});
