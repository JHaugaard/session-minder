// src/routes/capture.ts
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db.js';
import { requireAuth } from '../auth.js';

const VALID_PLATFORMS = ['claude_code', 'hermes', 'kimi_code'] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

interface CapturePayload {
  platform: Platform;
  external_session_id: string;
  event: 'start' | 'end';
  host: string;
  project_path?: string;
  message_count?: number;
}

function isValidPayload(body: unknown): body is CapturePayload {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.external_session_id === 'string' &&
    typeof b.host === 'string' &&
    (b.event === 'start' || b.event === 'end') &&
    typeof b.platform === 'string' &&
    (VALID_PLATFORMS as readonly string[]).includes(b.platform) &&
    (b.project_path === undefined || typeof b.project_path === 'string') &&
    (b.message_count === undefined || typeof b.message_count === 'number')
  );
}

export function registerCaptureRoute(app: FastifyInstance): void {
  app.post(
    '/api/sessions/capture',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = request.body;
      if (!isValidPayload(body)) {
        reply.code(400).send({ error: 'invalid payload' });
        return;
      }

      const sql = getSql();

      if (body.event === 'start') {
        await sql`
          INSERT INTO _sessionminder.sessions
            (platform, external_session_id, host, project_path, started_at)
          VALUES
            (${body.platform}, ${body.external_session_id}, ${body.host},
             ${body.project_path ?? null}, now())
          ON CONFLICT (platform, external_session_id) DO NOTHING
        `;
        reply.code(204).send();
        return;
      }

      // 'end' event handled in Task 6
      reply.code(501).send({ error: 'end event not yet implemented' });
    }
  );
}
