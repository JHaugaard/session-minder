// src/routes/attach.ts
import type { FastifyInstance } from 'fastify';
import { hostname } from 'node:os';
import { getSql } from '../db.js';
import { requireAuth } from '../auth.js';
import { resolveAttach, type SessionRow } from '../attach.js';
import {
  createHerdrClient,
  discoverHerdrSocket,
  HerdrUnreachableError,
  type HerdrPane,
} from '../herdr.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The hooks record `host` as the Tailscale short name (vps8-core), not the
// provider hostname (srv1086450), so the comparison must use the same name.
// SESSION_MINDER_HOST_NAME is set in the systemd unit; hostname() is only a
// last-resort fallback and will simply degrade if it disagrees.
function localHost(): string {
  return process.env.SESSION_MINDER_HOST_NAME ?? hostname();
}

export function registerAttachRoute(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/attach',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        reply.code(400).send({ error: 'invalid id' });
        return;
      }

      const sql = getSql();
      const [session] = await sql<SessionRow[]>`
        SELECT id, platform, external_session_id, host, project_path, ended_at
        FROM _sessionminder.sessions
        WHERE id = ${id}
      `;
      if (!session) {
        reply.code(404).send({ error: 'not found' });
        return;
      }

      const socketPath = await discoverHerdrSocket();
      const client = socketPath ? createHerdrClient(socketPath) : null;

      let panes: HerdrPane[] | null = null;
      if (client) {
        try {
          panes = await client.listPanes();
        } catch (err) {
          if (!(err instanceof HerdrUnreachableError)) throw err;
          panes = null;
        }
      }

      const plan = resolveAttach({ session, panes, localHost: localHost() });

      try {
        if (plan.kind === 'focus') {
          await client!.focusPane(plan.pane_id);
          reply.send({
            action: 'focused',
            pane_id: plan.pane_id,
            workspace_id: plan.workspace_id,
          });
          return;
        }

        if (plan.kind === 'spawn') {
          const tab = await client!.createTab({
            cwd: plan.cwd,
            label: 'resume',
          });
          const started = await client!.startAgent({
            paneId: tab.paneId,
            kind: plan.agent_kind,
            name: 'session-minder resume',
            args: plan.args,
          });
          reply.send({
            action: 'spawned',
            pane_id: tab.paneId,
            tab_id: tab.tabId,
            argv: started.argv,
          });
          return;
        }
      } catch (err) {
        // Herdr can stop between listPanes() and the action. Fall through to
        // the degrade answer rather than failing a request the user can still
        // satisfy by copying the command.
        if (!(err instanceof HerdrUnreachableError)) throw err;
        const fallback = resolveAttach({
          session,
          panes: null,
          localHost: localHost(),
        });
        reply.send({ action: 'degraded', ...stripKind(fallback) });
        return;
      }

      reply.send({ action: 'degraded', ...stripKind(plan) });
    }
  );
}

function stripKind(plan: { kind: string } & Record<string, unknown>) {
  const { kind: _kind, ...rest } = plan;
  return rest;
}
