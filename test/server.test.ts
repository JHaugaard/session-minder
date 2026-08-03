// test/server.test.ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

describe('GET /healthz', () => {
  it('returns 200 ok', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
