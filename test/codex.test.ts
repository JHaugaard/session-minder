import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from '../src/cli/sqlite.js';
import { canResumeCodex } from '../src/codex.js';
import { resolveAttach } from '../src/attach.js';

const id = '01a0723e-0108-75c3-a64c-49a6ce6ed613';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function store(recordId = id) {
  const dir = mkdtempSync(join(tmpdir(), 'sm-codex-'));
  dirs.push(dir);
  const rollout = join(dir, 'rollout.jsonl');
  writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: recordId } }) + '\n');
  const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(id, rollout);
  db.close();
  return { dir, rollout };
}

describe('Codex resume contract', () => {
  it('uses the native resume subcommand with the exact UUID', () => {
    expect(resolveAttach({ session: { id: 'row', platform: 'codex', external_session_id: id,
      project_path: '/tmp/project', host: 'vps8-core', ended_at: new Date() },
      panes: [], localHost: 'vps8-core' })).toEqual({ kind: 'spawn', cwd: '/tmp/project',
        agent_kind: 'codex', args: ['resume', id], command: `codex resume ${id}` });
  });
  it('requires both an indexed thread and matching readable metadata', () => {
    const { dir, rollout } = store();
    expect(canResumeCodex(id, dir)).toBe(true);
    expect(canResumeCodex('00000000-0000-0000-0000-000000000000', dir)).toBe(false);
    rmSync(rollout);
    expect(canResumeCodex(id, dir)).toBe(false);
  });
  it('rejects mismatched metadata, malformed IDs, and absent stores', () => {
    const { dir } = store('different-thread');
    expect(canResumeCodex(id, dir)).toBe(false);
    expect(canResumeCodex('--last', dir)).toBe(false);
    expect(canResumeCodex('a chat name', dir)).toBe(false);
    expect(canResumeCodex(id, '/not/a/codex/home')).toBe(false);
  });
});
