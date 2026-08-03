// src/auth.ts
import type { FastifyReply, FastifyRequest } from 'fastify';

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const expected = process.env.SESSION_MINDER_TOKEN;
  const header = request.headers.authorization;
  const provided = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  if (!expected || !provided || provided !== expected) {
    reply.code(401).send({ error: 'unauthorized' });
  }
}
