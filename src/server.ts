// src/server.ts
import Fastify, { FastifyInstance } from 'fastify';
import { registerCaptureRoute } from './routes/capture.js';
import { registerAttachRoute } from './routes/attach.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.get('/healthz', async () => ({ ok: true }));
  registerCaptureRoute(app);
  registerAttachRoute(app);

  return app;
}
