// src/db.ts
import postgres, { type Sql } from 'postgres';

let sql: Sql | undefined;

// Lazy: importing this module must never throw, or every test that touches
// buildServer() (Task 2's healthz test included) would demand a DATABASE_URL.
export function getSql(): Sql {
  if (!sql) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    sql = postgres(connectionString);
  }
  return sql;
}
