// test/auth.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../src/auth.js';

function mockReply() {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
  return reply;
}

describe('requireAuth', () => {
  beforeEach(() => {
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
  });

  it('rejects a missing Authorization header', async () => {
    const request = { headers: {} } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('rejects an incorrect token', async () => {
    const request = {
      headers: { authorization: 'Bearer wrong-token' },
    } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('allows the correct token', async () => {
    const request = {
      headers: { authorization: 'Bearer test-token-123' },
    } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });
});
