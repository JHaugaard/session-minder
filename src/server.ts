// src/server.ts
import Fastify, { FastifyInstance } from 'fastify';
import { registerCaptureRoute } from './routes/capture.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.get('/healthz', async () => ({ ok: true }));
  registerCaptureRoute(app);

  return app;
}
