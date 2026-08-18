// src/cli/sqlite.ts
// The single place `node:sqlite` enters this repo, and the single place the
// reason is written down.
//
// A plain `import { DatabaseSync } from 'node:sqlite'` works under tsx and
// under plain node, and fails under vitest: the Vite 5 bundled with vitest 2
// carries a hardcoded list of Node builtins that predates `node:sqlite`, so it
// strips the `node:` prefix, looks for a package called `sqlite` on disk, and
// dies with "Failed to load url sqlite". No vitest config setting overrides it
// — plugin resolveId, server.deps.external, and marking it external were all
// tried on 2026-08-14 and none of them win against the bundled resolver.
//
// createRequire defers the lookup to Node itself, which has had the module
// since 22. Same code path in tests and in production, and no build config to
// keep in sync.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Only the surface this repo actually uses. Typing the whole module would be
// inventing a contract we do not exercise.
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

export const { DatabaseSync } = require('node:sqlite') as SqliteModule;
