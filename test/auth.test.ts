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
    expect(reply.send).toHaveBeenCalledWith({ error: 'unauthorized' });
  });

  it('rejects an incorrect token', async () => {
    const request = {
      headers: { authorization: 'Bearer wrong-token' },
    } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'unauthorized' });
  });

  it('allows the correct token', async () => {
    const request = {
      headers: { authorization: 'Bearer test-token-123' },
    } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('fails closed when SESSION_MINDER_TOKEN is unset, even with a well-formed header', async () => {
    delete process.env.SESSION_MINDER_TOKEN;
    const request = {
      headers: { authorization: 'Bearer test-token-123' },
    } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'unauthorized' });
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
  });

  it('fails closed when SESSION_MINDER_TOKEN is empty, even with a well-formed header', async () => {
    process.env.SESSION_MINDER_TOKEN = '';
    const request = {
      headers: { authorization: 'Bearer test-token-123' },
    } as FastifyRequest;
    const reply = mockReply();
    await requireAuth(request, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'unauthorized' });
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
  });
});
