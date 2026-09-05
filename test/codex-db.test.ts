// Opt-in against an isolated database only. Never run against production.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getSql } from '../src/db.js';
import { buildServer } from '../src/server.js';

vi.mock('../src/herdr.js', async (original) => ({
  ...await original<typeof import('../src/herdr.js')>(), discoverHerdrSockets: async () => [],
}));
const url = process.env.SESSION_MINDER_TEST_DATABASE_URL;
describe.skipIf(!url)('Codex PostgreSQL lifecycle', () => {
  const id = '01a0723e-0108-75c3-a64c-49a6ce6ed613';
  const body = { platform: 'codex', external_session_id: id, host: 'vps8-core', project_path: '/tmp/project' };
  const app = buildServer();
  beforeAll(async () => {
    if (new URL(url!).pathname !== '/session_minder_codex_test') throw new Error('A dedicated test database is required');
    process.env.DATABASE_URL = url!;
    process.env.SESSION_MINDER_TOKEN = 'db-test';
    const sql = getSql();
    await sql.unsafe('CREATE SCHEMA _sessionminder');
    // Exercise the real migration from the previous three-platform schema.
    const schema = readFileSync(new URL('../db/02-tables.sql', import.meta.url), 'utf8').replace(", 'codex'", '');
    await sql.unsafe(schema);
    const reserved = await sql.reserve();
    try { await reserved.unsafe(readFileSync(new URL('../db/03-codex.sql', import.meta.url), 'utf8')); }
    finally { reserved.release(); }
  });
  afterAll(async () => {
    await app.close();
    if (url && new URL(url).pathname === '/session_minder_codex_test') {
      const sql = getSql();
      await sql.unsafe('DROP SCHEMA IF EXISTS _sessionminder CASCADE');
      await sql.end();
    }
  });
  async function capture(event: string, over = {}) {
    const res = await app.inject({ method: 'POST', url: '/api/sessions/capture',
      headers: { authorization: 'Bearer db-test' }, payload: { ...body, event, ...over } });
    expect(res.statusCode).toBe(204);
  }
  it('keeps one row across start, duplicate, end and resume, preserving curation', async () => {
    await capture('start');
    const sql = getSql();
    const [first] = await sql`SELECT * FROM _sessionminder.sessions WHERE external_session_id = ${id}`;
    await app.inject({ method: 'PUT', url: '/api/sessions/title', headers: { authorization: 'Bearer db-test' },
      payload: { platform: 'codex', external_session_id: id, title: 'Codex lifecycle' } });
    await capture('start'); await capture('end');
    const [ended] = await sql`SELECT * FROM _sessionminder.sessions WHERE external_session_id = ${id}`;
    expect(ended.ended_at).not.toBeNull();
    await capture('start', { project_path: '/tmp/resumed' });
    const rows = await sql`SELECT * FROM _sessionminder.sessions WHERE external_session_id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].started_at).toEqual(first.started_at);
    expect(rows[0].ended_at).toBeNull();
    expect(rows[0].title).toBe('Codex lifecycle');
    expect(rows[0].project_path).toBe('/tmp/resumed');
    const list = await app.inject({ url: '/api/sessions?q=Codex%20lifecycle', headers: { authorization: 'Bearer db-test' } });
    expect(list.json().sessions.map((r: any) => r.id)).toEqual([first.id]);
  });
  it('retains project path when only the end arrives and enforces uniqueness', async () => {
    const other = '00000000-0000-4000-8000-000000000001';
    await capture('end', { external_session_id: other });
    const sql = getSql();
    const [row] = await sql`SELECT * FROM _sessionminder.sessions WHERE external_session_id = ${other}`;
    expect(row.project_path).toBe(body.project_path);
    expect(row.ended_at).not.toBeNull();
    await expect(sql`INSERT INTO _sessionminder.sessions
      (platform, external_session_id, host, started_at) VALUES ('codex', ${other}, 'vps8-core', now())`).rejects.toMatchObject({ code: '23505' });
  });
});
