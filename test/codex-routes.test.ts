import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatList } from '../src/cli/rows.js';
import { renderOutcome } from '../src/cli/outcome.js';

const { sql, client, available } = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: (value: unknown) => value });
  return { sql, available: vi.fn(), client: { listPanes: vi.fn(), createTab: vi.fn(),
    startAgent: vi.fn(), focusPane: vi.fn(), closeTab: vi.fn() } };
});
vi.mock('../src/db.js', () => ({ getSql: () => sql }));
vi.mock('../src/codex.js', () => ({ canResumeCodex: available }));
vi.mock('../src/herdr.js', async (original) => ({
  ...await original<typeof import('../src/herdr.js')>(),
  discoverHerdrSockets: async () => ['/tmp/herdr.sock'], createHerdrClient: () => client,
}));
const { buildServer } = await import('../src/server.js');
const id = '01a0723e-0108-75c3-a64c-49a6ce6ed613';
const rowId = '11111111-2222-3333-4444-555555555555';
const body = { platform: 'codex', external_session_id: id, host: 'vps8-core', project_path: '/tmp/project' } as const;
const row = { ...body, id: rowId, ended_at: null, title: 'Codex integration', started_at: new Date().toISOString(),
  message_count: null, hermes_surface: null, foreign: false, live: false } as const;
async function request(method: 'POST' | 'PUT' | 'GET', url: string, payload?: any) {
  const app = buildServer();
  try { return await app.inject({ method, url, payload, headers: { authorization: 'Bearer test' } }); }
  finally { await app.close(); }
}
beforeEach(() => {
  vi.clearAllMocks(); sql.mockReset(); sql.mockResolvedValue([]);
  process.env.SESSION_MINDER_TOKEN = 'test'; process.env.SESSION_MINDER_HOST_NAME = 'vps8-core';
  client.listPanes.mockResolvedValue([]); available.mockReturnValue(true);
  client.createTab.mockResolvedValue({ paneId: 'w1:p2', tabId: 'w1:t2' });
  client.startAgent.mockResolvedValue({ argv: ['codex', 'resume', id] });
});
describe('Codex platform routes', () => {
  it.each(['start', 'end'])('accepts %s metadata without importing extra payload fields', async (event) => {
    const res = await request('POST', '/api/sessions/capture', { ...body, event, prompt: 'private text' });
    expect(res.statusCode).toBe(204);
    expect(sql.mock.calls[0].slice(1)).toContain(id);
    expect(sql.mock.calls[0].slice(1)).not.toContain('private text');
  });
  it.each([{ external_session_id: '--last' }, { external_session_id: '' }, { project_path: null },
    { project_path: 'relative' }, { event: 'Stop' }])('rejects invalid identity or event %j', async (over) => {
    expect((await request('POST', '/api/sessions/capture', { ...body, event: 'start', ...over })).statusCode).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
  it('reopens a thread without replacing its original start or title', async () => {
    await request('POST', '/api/sessions/capture', { ...body, event: 'start' });
    const update = sql.mock.calls[0][0].join('?').split('DO UPDATE')[1];
    expect(update).toContain('ended_at = NULL');
    expect(update).toContain('EXCLUDED.project_path');
    expect(update).toContain('|| EXCLUDED.raw_metadata');
    expect(update).not.toMatch(/started_at\s*=|title\s*=/);
  });
  it('allows deliberate titling', async () => {
    sql.mockResolvedValueOnce([{ id: rowId, title: 'Integration' }]);
    const res = await request('PUT', '/api/sessions/title', { ...body, title: 'Integration' });
    expect(res.statusCode).toBe(200);
    expect(sql.mock.calls[0].slice(1)).toContain('codex');
  });
  it('lists searchable Codex metadata with a Codex label', async () => {
    sql.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ count: 0 }]);
    const res = await request('GET', '/api/sessions?q=codex');
    expect(sql.mock.calls[0].slice(1)).toContain('%codex%');
    expect(formatList(res.json(), new Date()).join('\n')).toContain('codex');
    expect(res.json().sessions[0].title).toBe('Codex integration');
  });
  it('refuses missing local sessions before creating a tab', async () => {
    sql.mockResolvedValueOnce([row]); available.mockReturnValue(false);
    const res = await request('POST', `/api/sessions/${rowId}/attach`);
    expect(res.json()).toEqual({ action: 'degraded', reason: 'codex_session_unavailable', command: null });
    expect(client.createTab).not.toHaveBeenCalled();
    expect(renderOutcome(res.json(), row).lines[0]).toContain('no new session');
  });
  it('spawns the verified native resume command', async () => {
    sql.mockResolvedValueOnce([row]);
    const res = await request('POST', `/api/sessions/${rowId}/attach`);
    expect(res.json().action).toBe('spawned');
    expect(available).toHaveBeenCalledWith(id);
    expect(client.startAgent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'codex', args: ['resume', id] }));
  });
  it('focuses a live Codex session without needing its on-disk rollout', async () => {
    sql.mockResolvedValueOnce([row]); available.mockReturnValue(false);
    client.listPanes.mockResolvedValueOnce([{ pane_id: 'w2:p3', workspace_id: 'w2',
      agent_session: { agent: 'codex', source: 'herdr:codex', kind: 'id', value: id } }]);
    expect((await request('POST', `/api/sessions/${rowId}/attach`)).json().action).toBe('focused');
    expect(client.focusPane).toHaveBeenCalledWith('w2:p3');
    expect(client.createTab).not.toHaveBeenCalled();
  });
});
