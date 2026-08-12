// src/routes/title.ts
// The one write surface for curation. Phase 2.b deliberately shipped no way to
// set `title`; this is it, and it stays deliberately narrow — a name, and
// optionally the paragraph behind it. Nothing here sets `status` or deletes.
//
// Keyed on (platform, external_session_id) rather than the row id: that pair is
// the table's unique constraint and the only identity a caller naturally holds.
// A running Claude Code session knows its own id from $CLAUDE_CODE_SESSION_ID;
// it has no idea what our row uuid is, and should not have to look it up.
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db.js';
import { requireAuth } from '../auth.js';

const VALID_PLATFORMS = ['claude_code', 'hermes', 'kimi_code'] as const;

// The picker renders one line and pads its columns to the widest cell, so an
// unbounded title would blow up the layout for every other row. Rejected rather
// than truncated: truncation means you name a session and the picker shows
// something you did not write.
const MAX_TITLE = 60;

interface TitlePayload {
  platform: string;
  external_session_id: string;
  title: string;
  note?: string;
}

export function registerTitleRoute(app: FastifyInstance): void {
  app.put<{ Body: TitlePayload }>(
    '/api/sessions/title',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = request.body as Partial<TitlePayload> | null;

      if (typeof body !== 'object' || body === null) {
        reply.code(400).send({ error: 'invalid payload' });
        return;
      }
      if (!(VALID_PLATFORMS as readonly string[]).includes(String(body.platform))) {
        reply
          .code(400)
          .send({ error: `platform must be one of ${VALID_PLATFORMS.join(', ')}` });
        return;
      }
      if (typeof body.external_session_id !== 'string' || body.external_session_id === '') {
        reply.code(400).send({ error: 'external_session_id is required' });
        return;
      }
      // Bound to consts after validation. Narrowing on the properties of a cast
      // object does not survive into the sql template below, and postgres.js
      // rejects `string | undefined` as a parameter type.
      const platform: string = String(body.platform);
      const externalSessionId: string = body.external_session_id;
      if (typeof body.title !== 'string') {
        reply.code(400).send({ error: 'title is required' });
        return;
      }

      const title = body.title.trim();
      if (title === '') {
        // An empty title would make the picker fall back to the folder name,
        // which reads exactly like the titling silently failed.
        reply.code(400).send({ error: 'title cannot be empty' });
        return;
      }
      if (title.length > MAX_TITLE) {
        reply.code(400).send({ error: `title cannot exceed ${MAX_TITLE} characters` });
        return;
      }

      const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note : null;

      const sql = getSql();
      // UPDATE, never upsert. A row that was never captured has no start time,
      // no project path and no duration — inventing one would put a ghost
      // session in the picker that the user could then try to resume.
      //
      // title is assigned outright (John's ruling 2026-08-11: re-titling
      // replaces, so a correction actually corrects). note is COALESCEd on the
      // PARAMETER, so omitting it leaves an existing paragraph intact instead
      // of nulling it out every time a name is fixed.
      const rows = await sql<{ id: string; title: string }[]>`
        UPDATE _sessionminder.sessions
        SET title = ${title},
            note = COALESCE(${note}, note)
        WHERE platform = ${platform}
          AND external_session_id = ${externalSessionId}
        RETURNING id, title
      `;

      if (rows.length === 0) {
        reply.code(404).send({ error: 'no session matches that platform and id' });
        return;
      }

      reply.send({ id: rows[0].id, title: rows[0].title });
    }
  );
}
