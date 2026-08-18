// test/hermes-state.test.ts
// Fixtures are real SQLite files in a real temp tree, not a mock. The whole
// point of this module is that it agrees with a foreign store's actual layout,
// and a fake would agree with whatever this test believed on the day it was
// written — which is exactly how the Herdr fake went blind (see CLAUDE.md).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from '../src/cli/sqlite.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverStateDbs,
  openReadOnly,
  readTitles,
  collectHermesTitles,
} from '../src/cli/hermes-state.js';

let home: string;

// WAL, because the live Hermes stores are WAL and a read-only open against WAL
// is the case that can fail outright.
function makeDb(path: string, rows: [string, string | null, number | null][]): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, message_count INTEGER)');
  const insert = db.prepare('INSERT INTO sessions (id, title, message_count) VALUES (?, ?, ?)');
  for (const [id, title, count] of rows) insert.run(id, title, count);
  db.close();
}

function profileDir(name: string): string {
  const dir = join(home, '.hermes', 'profiles', name);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'state.db');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hermes-state-'));
  mkdirSync(join(home, '.hermes'), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('discoverStateDbs', () => {
  it('finds the per-profile databases, not just the root one', () => {
    makeDb(join(home, '.hermes', 'state.db'), []);
    makeDb(profileDir('mccoy'), []);
    makeDb(profileDir('vulcan'), []);

    const found = discoverStateDbs(home);

    // Returning only `~/.hermes/state.db` is the implementation this catches,
    // and it is the one a reasonable person writes. Measured on the live
    // install: 18 of the 20 most recent Hermes sessions were in profiles/mccoy
    // and exactly 1 was in the root store, so root-only finds ~5% of the data
    // while looking like it worked.
    expect(found).toHaveLength(3);
    expect(found).toContain(join(home, '.hermes', 'profiles', 'mccoy', 'state.db'));
    expect(found).toContain(join(home, '.hermes', 'profiles', 'vulcan', 'state.db'));
  });

  it('omits paths that do not exist rather than handing back a phantom', () => {
    // No root state.db — only a profile has one.
    makeDb(profileDir('the-beav'), []);

    const found = discoverStateDbs(home);

    // Catches returning the root path unconditionally: the caller would then
    // open a file that isn't there and report an "unreadable database" on every
    // run of a perfectly healthy install.
    expect(found).toEqual([join(home, '.hermes', 'profiles', 'the-beav', 'state.db')]);
  });

  it('orders profiles deterministically', () => {
    makeDb(profileDir('vulcan'), []);
    makeDb(profileDir('canens'), []);
    makeDb(profileDir('mccoy'), []);

    // Catches raw readdir order. Collision resolution downstream is first-wins,
    // so an unstable order means the same input can produce a different title.
    expect(discoverStateDbs(home)).toEqual([
      join(home, '.hermes', 'profiles', 'canens', 'state.db'),
      join(home, '.hermes', 'profiles', 'mccoy', 'state.db'),
      join(home, '.hermes', 'profiles', 'vulcan', 'state.db'),
    ]);
  });
});

describe('openReadOnly', () => {
  it('returns a handle that cannot write', () => {
    const path = join(home, '.hermes', 'state.db');
    makeDb(path, [['s1', 'Original', 3]]);

    const db = openReadOnly(path);
    // Catches `new DatabaseSync(path)` — the default is read-write, and this
    // module runs against databases a live Hermes is actively writing.
    // (A sidecar-file check does NOT catch it: verified 2026-08-14 that both
    // modes create -wal/-shm on read, so that assertion would be theatre.)
    expect(() => db.prepare('UPDATE sessions SET title = ?').run('Clobbered')).toThrow();
    db.close();

    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare('SELECT title FROM sessions').get()).toEqual({ title: 'Original' });
    check.close();
  });
});

describe('readTitles', () => {
  it('skips sessions Hermes never titled, including whitespace-only titles', () => {
    const path = join(home, '.hermes', 'state.db');
    makeDb(path, [
      ['s1', 'Fixing Vulcan Telegram Gateway Outage', 12],
      ['s2', null, 4],
      ['s3', '   ', 7],
      ['s4', '', 1],
    ]);

    const titles = readTitles(path);

    // `WHERE title IS NOT NULL` alone is the implementation this catches: it
    // lets '   ' and '' through, and the title route rejects empty titles with
    // a 400 — so the harvest would report failures that are really just Hermes
    // having no name for that session.
    expect(titles.map((t) => t.external_session_id)).toEqual(['s1']);
    expect(titles[0].title).toBe('Fixing Vulcan Telegram Gateway Outage');
    expect(titles[0].message_count).toBe(12);
    expect(titles[0].source).toBe(path);
  });

  it('trims surrounding whitespace off the title it hands back', () => {
    const path = join(home, '.hermes', 'state.db');
    makeDb(path, [['s1', '  VPS8 Backup Plan Note  ', 2]]);

    // Catches passing the raw column through: the padded string is a different
    // 60-character budget and shows up padded in the picker.
    expect(readTitles(path)[0].title).toBe('VPS8 Backup Plan Note');
  });
});

describe('collectHermesTitles', () => {
  it('keeps going when one database is unreadable', () => {
    const good = join(home, '.hermes', 'state.db');
    makeDb(good, [['s1', 'Real title', 5]]);
    const broken = profileDir('busted');
    writeFileSync(broken, 'this is not a sqlite database');

    const result = collectHermesTitles([broken, good]);

    // Catches letting the error propagate. One corrupt or locked profile store
    // would otherwise cost the entire harvest — measured: 48 titles live behind
    // seven separate files.
    expect(result.titles.map((t) => t.title)).toEqual(['Real title']);
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0].path).toBe(broken);
  });

  it('resolves a duplicate id first-wins and reports the discarded title', () => {
    const first = join(home, '.hermes', 'state.db');
    const second = profileDir('mccoy');
    makeDb(first, [['dup', 'Title from root', 9]]);
    makeDb(second, [['dup', 'Title from mccoy', 9]]);

    const result = collectHermesTitles([first, second]);

    // Catches last-wins-silently. Nothing here can know which store is right,
    // so the rule has to be stated and the loser has to be visible rather than
    // overwritten without a word.
    expect(result.titles).toHaveLength(1);
    expect(result.titles[0].title).toBe('Title from root');
    expect(result.collisions).toEqual([
      { external_session_id: 'dup', kept: 'Title from root', discarded: 'Title from mccoy' },
    ]);
  });

  it('does not report a collision when both stores agree', () => {
    const first = join(home, '.hermes', 'state.db');
    const second = profileDir('mccoy');
    makeDb(first, [['dup', 'Same title', 9]]);
    makeDb(second, [['dup', 'Same title', 9]]);

    // Catches counting every duplicate as a conflict, which would bury the real
    // conflicts in noise.
    expect(collectHermesTitles([first, second]).collisions).toEqual([]);
  });
});
