// test/attach-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { herdrAgentName } from '../src/attach.js';

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

    // Pins the route's own SELECT, in the same style as test/capture.test.ts.
    // mockSql returns a hand-built row regardless of the query text, so
    // dropping a column here (project_path, most critically) would pass
    // every other route test while every spawn degraded with
    // no_project_path in production.
    const [strings] = mockSql.mock.calls[0];
    const queryText = strings.join('?');
    expect(queryText).toMatch(/_sessionminder\.sessions/);
    expect(queryText).toMatch(/project_path/);
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
    // Pins Herdr's agent-name rule, not the literal string. agent.start rejects
    // names outside ^[a-z][a-z0-9_-]{0,31}$ with `invalid_agent_name`, and because
    // src/herdr.ts maps protocol errors to HerdrUnreachableError, a violation
    // reaches the caller as a misleading "herdr_unreachable" degrade with an
    // orphaned tab left behind. Verified live: a space here broke every spawn.
    const startedWith = mockClient.startAgent.mock.calls[0][0];
    expect(startedWith.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    // Pins that the name is DERIVED from the session, not a constant — a
    // hard-coded name can only ever have one live agent, which is the exact
    // defect this fix addresses. Fails if someone reinstates a fixed string.
    expect(startedWith.name).toBe(herdrAgentName(row().external_session_id));
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

  it('closes the orphaned tab when startAgent fails after createTab succeeded', async () => {
    const { HerdrUnreachableError } = await import('../src/herdr.js');
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([]);
    mockClient.createTab.mockResolvedValueOnce({ paneId: 'w9:p3', tabId: 'w9:t2' });
    mockClient.startAgent.mockRejectedValueOnce(new HerdrUnreachableError('agent_name_taken'));

    const res = await post();

    // Pins the leak fix directly: Herdr never reports agent_session for
    // Hermes panes, so every re-attach to a live Hermes session takes this
    // spawn branch, hits agent_name_taken, and — without this cleanup —
    // leaves the tab createTab() just created permanently orphaned.
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('degraded');
    expect(mockClient.closeTab).toHaveBeenCalledWith('w9:t2');
  });

  it('degrades with herdr_rejected carrying Herdr code and message when startAgent is refused', async () => {
    const { HerdrRejectedError } = await import('../src/herdr.js');
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([]);
    mockClient.createTab.mockResolvedValueOnce({ paneId: 'w9:p3', tabId: 'w9:t2' });
    mockClient.startAgent.mockRejectedValueOnce(
      new HerdrRejectedError(
        'agent_name_taken',
        'an agent named sm-abc-123 is already running',
        'agent.start'
      )
    );

    const res = await post();

    // The whole point of Task 1's split, seen from the outside: a refusal must
    // arrive at the client as Herdr's OWN code and message, not as the generic
    // "can't be reached". This is the live `agent_name_taken` case — every
    // re-attach to a running Hermes session lands here.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      action: 'degraded',
      reason: 'herdr_rejected',
      command: 'claude --resume abc-123',
      herdr_code: 'agent_name_taken',
      herdr_message: 'an agent named sm-abc-123 is already running',
    });
    // A rejection AFTER tab.create succeeded is precisely the orphan case, so
    // cleanup must fire for this class exactly as it fires for unreachable.
    expect(mockClient.closeTab).toHaveBeenCalledWith('w9:t2');
  });

  it('degrades with herdr_rejected when focusPane is refused, without any tab cleanup', async () => {
    const { HerdrRejectedError } = await import('../src/herdr.js');
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([
      { pane_id: 'w9:p1', workspace_id: 'w9', tab_id: 'w9:t1', cwd: '/home/john/dev/wayfinder',
        agent: 'claude',
        agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: 'abc-123' } },
    ]);
    mockClient.focusPane.mockRejectedValueOnce(
      new HerdrRejectedError('pane_not_found', 'no pane w9:p1', 'pane.focus')
    );

    const res = await post();

    // Separate catch site from the spawn path — a fix to one does not protect
    // the other. Narrowing this guard back to HerdrUnreachableError alone turns
    // a refusal into a 500 for a session the user could still resume by hand.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      action: 'degraded',
      reason: 'herdr_rejected',
      command: 'claude --resume abc-123',
      herdr_code: 'pane_not_found',
      herdr_message: 'no pane w9:p1',
    });
    // Nothing was created on this path, so nothing may be closed.
    expect(mockClient.closeTab).not.toHaveBeenCalled();
  });

  it('degrades with herdr_rejected when listPanes itself is refused', async () => {
    const { HerdrRejectedError } = await import('../src/herdr.js');
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockRejectedValueOnce(
      new HerdrRejectedError('invalid_request', 'unknown variant pane.list', 'pane.list')
    );

    const res = await post();

    // The step-tracking rule. listPanes failing sets panes=null, and
    // resolveAttach(panes:null) always says `herdr_unreachable` — so unless the
    // route REMEMBERS which class actually failed, a refusal here silently
    // reports the wrong cause. That is the 2.a bug reproduced one layer up.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      action: 'degraded',
      reason: 'herdr_rejected',
      command: 'claude --resume abc-123',
      herdr_code: 'invalid_request',
      herdr_message: 'unknown variant pane.list',
    });
  });

  it('keeps unreachable degrades free of herdr_code and herdr_message', async () => {
    const { HerdrUnreachableError } = await import('../src/herdr.js');
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([]);
    mockClient.createTab.mockResolvedValueOnce({ paneId: 'w9:p3', tabId: 'w9:t2' });
    mockClient.startAgent.mockRejectedValueOnce(new HerdrUnreachableError('socket died'));

    const res = await post();

    // toEqual, not toMatchObject: the absence of the rejection fields is the
    // assertion. A helper that stamps `herdr_rejected` on every degrade would
    // pass a shape-only check while lying about every unreachable case — and
    // would put OUR internal error text where Herdr's words belong.
    expect(res.json()).toEqual({
      action: 'degraded',
      reason: 'herdr_unreachable',
      command: 'claude --resume abc-123',
    });
  });

  it('does not degrade when startAgent fails with a non-Herdr error', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    mockDiscover.mockResolvedValueOnce('/tmp/herdr.sock');
    mockClient.listPanes.mockResolvedValueOnce([]);
    mockClient.createTab.mockResolvedValueOnce({ paneId: 'w9:p3', tabId: 'w9:t2' });
    mockClient.startAgent.mockRejectedValueOnce(new TypeError('bug in the client'));

    const res = await post();

    // Widening the guard from one Herdr class to two must not widen it to
    // "anything". Only the two Herdr classes degrade; a genuine bug is still a
    // 500. This is 2.a's surviving-mutant-6 pattern, re-pinned at the exact
    // catch site the split touches.
    expect(res.statusCode).toBe(500);
    expect(res.json().action).toBeUndefined();
  });

  it('degrades for a session captured on another host without ever focusing or spawning', async () => {
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
