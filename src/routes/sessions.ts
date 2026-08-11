// src/routes/sessions.ts
// The one new API surface in Phase 2.b. The `sm` picker is a pure client of
// this endpoint — every display decision it makes has to be answerable from
// this response alone, which is why `foreign` and `hermes_surface` are computed
// here rather than left for the CLI to re-derive.
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db.js';
import { requireAuth } from '../auth.js';
import { localHost } from '../host.js';
import {
  createHerdrClient,
  discoverHerdrSocket,
  HerdrUnreachableError,
  HerdrRejectedError,
} from '../herdr.js';

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 100;

interface SessionListRow {
  id: string;
  platform: string;
  title: string | null;
  project_path: string | null;
  host: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  message_count: number | null;
  hermes_surface: string | null;
  external_session_id: string;
}

function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string') return DEFAULT_LIMIT;
  const n = Number(raw);
  // `Number('')` is 0 and `Number('abc')` is NaN — both are "the caller did not
  // give us a limit", not "the caller asked for zero rows".
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

export function registerSessionsRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { q?: string; noise?: string; limit?: string } }>(
    '/api/sessions',
    { preHandler: requireAuth },
    async (request) => {
      const sql = getSql();
      const { q, noise, limit: rawLimit } = request.query;

      const includeNoise = noise === 'true';
      // NULL means "no text filter" — not "match everything". `'%'` would look
      // equivalent and silently drop every row with a NULL title, because
      // `NULL ILIKE '%'` is NULL, not true.
      const pattern = q ? `%${q}%` : null;
      const limit = parseLimit(rawLimit);

      // ONE query shape, with every variation carried in parameters rather
      // than in conditionally-assembled SQL fragments. Two reasons, both
      // deliberate: the query text the tests inspect is byte-for-byte the text
      // production runs (a fragment-based build would show the mock something
      // different from what postgres.js assembles), and there is exactly one
      // place a filter can be dropped from.
      const rows = await sql<SessionListRow[]>`
        SELECT id, platform, title, project_path, host, started_at, ended_at,
               message_count, external_session_id,
               raw_metadata -> 'hermes' ->> 'surface' AS hermes_surface
        FROM _sessionminder.sessions
        WHERE status <> 'pruned'
          AND (${includeNoise}::bool OR noise_flag = false)
          AND (${pattern}::text IS NULL
               OR COALESCE(title, '') ILIKE ${pattern}
               OR COALESCE(project_path, '') ILIKE ${pattern}
               OR platform ILIKE ${pattern})
        ORDER BY started_at DESC
        LIMIT ${limit}
      `;

      // How many rows `sm --all` would add to what you are looking at right
      // now — so it respects `q` and the pruned filter, but not the limit.
      // Skipped entirely when noise is already included: there is nothing left
      // to reveal, and the honest answer is 0.
      let noiseHidden = 0;
      if (!includeNoise) {
        const [counted] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM _sessionminder.sessions
          WHERE status <> 'pruned'
            AND noise_flag = true
            AND (${pattern}::text IS NULL
                 OR COALESCE(title, '') ILIKE ${pattern}
                 OR COALESCE(project_path, '') ILIKE ${pattern}
                 OR platform ILIKE ${pattern})
        `;
        noiseHidden = counted?.count ?? 0;
      }

      // Liveness is never stored. It is a join against Herdr's live panes,
      // computed at request time on the same key the attach route focuses on.
      let liveIds: Set<string> | null = null;
      let herdr: 'ok' | 'unreachable' | 'rejected' = 'unreachable';
      const socketPath = await discoverHerdrSocket();
      if (socketPath) {
        try {
          const panes = await createHerdrClient(socketPath).listPanes();
          liveIds = new Set(
            panes
              .map((p) => p.agent_session?.value)
              .filter((v): v is string => typeof v === 'string')
          );
          herdr = 'ok';
        } catch (err) {
          // The list must never fail for want of Herdr — sessions live in
          // Postgres. Both Herdr classes are tolerated here and reported
          // distinctly; anything else is a real bug and still throws.
          if (err instanceof HerdrRejectedError) {
            herdr = 'rejected';
          } else if (err instanceof HerdrUnreachableError) {
            herdr = 'unreachable';
          } else {
            throw err;
          }
          request.log.warn({ err }, 'herdr listPanes failed; live markers unavailable');
        }
      }

      const local = localHost();

      return {
        sessions: rows.map((r) => ({
          id: r.id,
          platform: r.platform,
          title: r.title,
          project_path: r.project_path,
          host: r.host,
          foreign: r.host !== local,
          started_at: iso(r.started_at),
          ended_at: iso(r.ended_at),
          message_count: r.message_count,
          hermes_surface: r.hermes_surface,
          // null, not false, when Herdr could not answer: "not live" and "we
          // don't know" are different facts and the picker renders them
          // differently. external_session_id is deliberately not returned —
          // it is a join key, and the spec shows no ids in the list.
          live: liveIds === null ? null : liveIds.has(r.external_session_id),
        })),
        noise_hidden: noiseHidden,
        herdr,
      };
    }
  );
}
