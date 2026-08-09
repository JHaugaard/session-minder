// src/routes/capture.ts
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db.js';
import { requireAuth } from '../auth.js';
import { isNoise } from '../noise.js';

const VALID_PLATFORMS = ['claude_code', 'hermes', 'kimi_code'] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

// Herdr exports these into every pane it owns; the hook scripts pass them
// straight through. Kept as a flat all-strings object so validation is a
// one-liner and the stored jsonb stays predictable for later consumers.
type HerdrCaptureRef = {
  session: string;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  socket_path: string;
};

const HERDR_REF_FIELDS = [
  'session',
  'workspace_id',
  'tab_id',
  'pane_id',
  'socket_path',
] as const;

function isValidHerdrRef(value: unknown): value is HerdrCaptureRef {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return HERDR_REF_FIELDS.every((f) => typeof v[f] === 'string');
}

interface CapturePayload {
  platform: Platform;
  external_session_id: string;
  event: 'start' | 'end';
  host: string;
  project_path?: string;
  message_count?: number;
  herdr?: HerdrCaptureRef;
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
    (b.message_count === undefined || typeof b.message_count === 'number') &&
    (b.herdr === undefined || isValidHerdrRef(b.herdr))
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

      // `{}` (not null) when absent: the column is NOT NULL, and jsonb `||`
      // with an empty object is a no-op, so both branches use one value.
      const rawMetadata = body.herdr ? { herdr: body.herdr } : {};

      if (body.event === 'start') {
        await sql`
          INSERT INTO _sessionminder.sessions
            (platform, external_session_id, host, project_path, started_at,
             raw_metadata)
          VALUES
            (${body.platform}, ${body.external_session_id}, ${body.host},
             ${body.project_path ?? null}, now(), ${sql.json(rawMetadata)})
          ON CONFLICT (platform, external_session_id) DO NOTHING
        `;
        reply.code(204).send();
        return;
      }

      // event === 'end'
      const messageCount = body.message_count ?? null;

      const [existing] = await sql<{ started_at: Date }[]>`
        SELECT started_at FROM _sessionminder.sessions
        WHERE platform = ${body.platform}
          AND external_session_id = ${body.external_session_id}
      `;

      const durationSeconds = existing
        ? (Date.now() - new Date(existing.started_at).getTime()) / 1000
        : null;

      const noiseFlag = isNoise({ durationSeconds, messageCount });

      // Upsert, not plain UPDATE: if the start capture was missed (service
      // down, machine offline), the end event still records the session
      // instead of matching zero rows and vanishing (spec Data Model: "the
      // end hook upserts"). In the missed-start case started_at is unknown,
      // so it falls back to now() and durationSeconds stays null.
      await sql`
        INSERT INTO _sessionminder.sessions
          (platform, external_session_id, host, started_at, ended_at,
           message_count, noise_flag, raw_metadata)
        VALUES
          (${body.platform}, ${body.external_session_id}, ${body.host},
           now(), now(), ${messageCount}, ${noiseFlag}, ${sql.json(rawMetadata)})
        ON CONFLICT (platform, external_session_id) DO UPDATE
        SET ended_at = now(),
            message_count = COALESCE(${messageCount}, _sessionminder.sessions.message_count),
            noise_flag = ${noiseFlag},
            raw_metadata = _sessionminder.sessions.raw_metadata || ${sql.json(rawMetadata)}
      `;
      reply.code(204).send();
      return;
    }
  );
}
