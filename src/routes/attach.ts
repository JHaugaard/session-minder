// src/routes/attach.ts
import type { FastifyInstance } from 'fastify';
import { hostname } from 'node:os';
import { getSql } from '../db.js';
import { requireAuth } from '../auth.js';
import { resolveAttach, herdrAgentName, type SessionRow, type AttachPlan } from '../attach.js';
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
  // `||`, not `??`: .env.example sets values empty by convention, and a blank
  // SESSION_MINDER_HOST_NAME= would make `??` return '' (an empty string is
  // not nullish), so every attach would degrade with foreign_host.
  return process.env.SESSION_MINDER_HOST_NAME || hostname();
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
      if (!socketPath) {
        request.log.warn('herdr socket discovery found no live candidate; degrading');
      }
      const client = socketPath ? createHerdrClient(socketPath) : null;

      let panes: HerdrPane[] | null = null;
      if (client) {
        try {
          panes = await client.listPanes();
        } catch (err) {
          if (!(err instanceof HerdrUnreachableError)) throw err;
          request.log.warn({ err }, 'herdr listPanes failed; degrading');
          panes = null;
        }
      }

      const plan = resolveAttach({ session, panes, localHost: localHost() });

      // Herdr can stop between listPanes() and the action below. Both
      // branches fall through to the degrade answer rather than failing a
      // request the user can still satisfy by copying the command.
      if (plan.kind === 'focus') {
        try {
          await client!.focusPane(plan.pane_id);
          reply.send({
            action: 'focused',
            pane_id: plan.pane_id,
            workspace_id: plan.workspace_id,
          });
          return;
        } catch (err) {
          if (!(err instanceof HerdrUnreachableError)) throw err;
          request.log.warn({ err }, 'herdr focusPane failed; degrading');
          reply.send({ action: 'degraded', ...stripKind(degradeFallback(session)) });
          return;
        }
      }

      if (plan.kind === 'spawn') {
        // Tracked so the catch below can clean up an orphaned tab — see B4.
        let tabId: string | undefined;
        try {
          const tab = await client!.createTab({
            cwd: plan.cwd,
            label: 'resume',
          });
          tabId = tab.tabId;
          const started = await client!.startAgent({
            paneId: tab.paneId,
            kind: plan.agent_kind,
            // Herdr's agent.start enforces two rules: the name must match
            // ^[a-z][a-z0-9_-]{0,31}$, AND it must be unique among live agents
            // (a second spawn with a taken name is rejected outright). Both
            // failure modes are protocol errors that src/herdr.ts maps to
            // HerdrUnreachableError — so either one surfaces to the caller as
            // a misleading "Herdr unreachable" degrade, with an orphaned tab
            // left behind since tab.create already succeeded.
            name: herdrAgentName(session.external_session_id),
            args: plan.args,
          });
          reply.send({
            action: 'spawned',
            pane_id: tab.paneId,
            tab_id: tab.tabId,
            argv: started.argv,
          });
          return;
        } catch (err) {
          if (!(err instanceof HerdrUnreachableError)) throw err;
          request.log.warn({ err }, 'herdr spawn failed; degrading');
          // Herdr never reports agent_session for Hermes panes (see
          // src/herdr.ts), so every re-attach to a LIVE Hermes session takes
          // this spawn branch and hits agent_name_taken on the identical
          // derived name — createTab already succeeded by that point, so
          // without this cleanup the tab leaks permanently on every such
          // re-attach. Best-effort only: a cleanup failure must never turn a
          // degrade into a 500.
          if (tabId) {
            try {
              await client!.closeTab(tabId);
            } catch {
              // Swallowed intentionally — see comment above.
            }
          }
          reply.send({ action: 'degraded', ...stripKind(degradeFallback(session)) });
          return;
        }
      }

      reply.send({ action: 'degraded', ...stripKind(plan) });
    }
  );
}

function degradeFallback(session: SessionRow) {
  const fallback = resolveAttach({
    session,
    panes: null,
    localHost: localHost(),
  });
  // Structurally guaranteed by resolveAttach (panes: null always yields a
  // degrade plan — see Task 5's non-null-assertion proof), but the static
  // type is still the full AttachPlan union. Narrow explicitly rather than
  // casting, so a future change to that contract fails loudly here instead
  // of leaking spawn/focus fields into the body.
  if (fallback.kind !== 'degrade') {
    throw new Error('resolveAttach returned a non-degrade plan for panes: null');
  }
  return fallback;
}

function stripKind(plan: Extract<AttachPlan, { kind: 'degrade' }>) {
  const { kind: _kind, ...rest } = plan;
  return rest;
}
