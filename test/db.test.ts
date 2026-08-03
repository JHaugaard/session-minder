// test/db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('db', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('does not throw on import when DATABASE_URL is unset', async () => {
    await expect(import('../src/db.js')).resolves.toBeDefined();
  });

  it('throws only when getSql() is called without DATABASE_URL set', async () => {
    const { getSql } = await import('../src/db.js');
    expect(() => getSql()).toThrow('DATABASE_URL is not set');
  });
});
