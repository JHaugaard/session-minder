import { readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { SqliteDatabase } from './cli/sqlite.js';
import { CODEX_ID_RE } from './codex-id.js';

// Read only the local metadata index and the rollout's first record. Never
// invoke `codex resume` as a probe: an invalid target must not create a chat.
// Observed contract: Codex 0.153.4, state_5.sqlite, session_meta.id.
export function canResumeCodex(id: string, home = process.env.CODEX_HOME || join(homedir(), '.codex')): boolean {
  if (!CODEX_ID_RE.test(id)) return false;
  try {
    const stores = readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!stores[0]) return false;
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase;
    };
    const db = new DatabaseSync(join(home, stores[0]), { readOnly: true });
    let row: { rollout_path: string } | undefined;
    try {
      row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(id) as typeof row;
    } finally { db.close(); }
    if (!row || typeof row.rollout_path !== 'string') return false;
    const fd = openSync(row.rollout_path, 'r');
    try {
      // Metadata can include large base instructions. Bound the read and
      // refuse unfamiliar or incomplete formats instead of guessing.
      const buf = Buffer.alloc(1024 * 1024);
      const length = readSync(fd, buf, 0, buf.length, 0);
      const first = buf.subarray(0, length).toString('utf8').split('\n')[0];
      const record = JSON.parse(first);
      return record.type === 'session_meta' && (record.payload?.id ?? record.payload?.session_id) === id;
    } finally { closeSync(fd); }
  } catch { return false; }
}
