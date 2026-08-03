// src/server.ts
import Fastify, { FastifyInstance } from 'fastify';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.get('/healthz', async () => ({ ok: true }));

  return app;
}
