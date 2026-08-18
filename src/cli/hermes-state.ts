// src/cli/hermes-state.ts
// Reads titles out of Hermes' OWN session store. This lives under src/cli/
// deliberately: the service never touches Hermes' database. The harvester is a
// client, exactly like `sm` — it reads a foreign store and writes through the
// HTTP API, so the "no client touches the database" boundary still holds for
// the one database that is ours.
//
// Verified against the live install 2026-08-14. Two facts that cost time:
//
//   1. `~/.hermes/sessions/*.json` LOOKS like the transcript store and is
//      stale — the newest real session files there are months old. The live
//      data moved into SQLite with no version bump, which is the third time a
//      "confirmed" Hermes fact has expired that way (see CLAUDE.md).
//   2. There is not one database. There is `~/.hermes/state.db` plus one
//      `state.db` per profile. Of the 20 most recently captured Hermes
//      sessions, 1 was in the root database and 18 were in profiles/mccoy.
//      Reading only the root finds almost nothing, so discovery globs.
import { DatabaseSync, type SqliteDatabase } from './sqlite.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface HermesTitle {
  external_session_id: string;
  title: string;
  message_count: number | null;
  source: string;
}

export interface Collected {
  titles: HermesTitle[];
  // A profile whose database is missing, locked, or not a database at all must
  // not cost us the other six. Reported rather than thrown.
  unreadable: { path: string; error: string }[];
  // The same session id appearing in two stores with two different titles is
  // not resolvable from here — nothing says which is right. First-wins in the
  // order given, and the loser is surfaced instead of vanishing.
  collisions: { external_session_id: string; kept: string; discarded: string }[];
}

// Sorted, so the order paths come back in is stable across runs — collision
// resolution is first-wins and would otherwise depend on readdir order.
export function discoverStateDbs(home: string = homedir()): string[] {
  const root = join(home, '.hermes');
  const candidates = [join(root, 'state.db')];

  let profiles: string[] = [];
  try {
    profiles = readdirSync(join(root, 'profiles')).sort();
  } catch {
    // No profiles directory at all is a legitimate Hermes install, not an error.
    profiles = [];
  }
  for (const name of profiles) candidates.push(join(root, 'profiles', name, 'state.db'));

  return candidates.filter((p) => existsSync(p));
}

// The only place a Hermes database is opened. `readOnly` is not a nicety: this
// runs against databases a live Hermes is writing to, and an accidental write
// handle on someone else's WAL store is how you corrupt a session log you had
// no business touching.
export function openReadOnly(path: string): SqliteDatabase {
  return new DatabaseSync(path, { readOnly: true });
}

export function readTitles(path: string): HermesTitle[] {
  const db = openReadOnly(path);
  try {
    // `trim(title) <> ''` and not merely `title IS NOT NULL`: a whitespace-only
    // title is not a name. Passed through, it would be rejected by the title
    // route on every single row, so the run would report failures that are
    // really just Hermes having nothing to say.
    const rows = db
      .prepare(
        `SELECT id, title, message_count
           FROM sessions
          WHERE title IS NOT NULL AND trim(title) <> ''`
      )
      .all() as { id: string; title: string; message_count: number | null }[];

    return rows.map((r) => ({
      external_session_id: String(r.id),
      title: String(r.title).trim(),
      message_count: r.message_count === null ? null : Number(r.message_count),
      source: path,
    }));
  } finally {
    db.close();
  }
}

export function collectHermesTitles(
  paths: string[],
  read: (path: string) => HermesTitle[] = readTitles
): Collected {
  const byId = new Map<string, HermesTitle>();
  const unreadable: Collected['unreadable'] = [];
  const collisions: Collected['collisions'] = [];

  for (const path of paths) {
    let rows: HermesTitle[];
    try {
      rows = read(path);
    } catch (err) {
      unreadable.push({ path, error: (err as Error).message });
      continue;
    }
    for (const row of rows) {
      const existing = byId.get(row.external_session_id);
      if (existing) {
        if (existing.title !== row.title) {
          collisions.push({
            external_session_id: row.external_session_id,
            kept: existing.title,
            discarded: row.title,
          });
        }
        continue;
      }
      byId.set(row.external_session_id, row);
    }
  }

  return { titles: [...byId.values()], unreadable, collisions };
}
