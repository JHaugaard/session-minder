// src/routes/attach.ts
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db.js';
import { localHost } from '../host.js';
import { requireAuth } from '../auth.js';
import { resolveAttach, herdrAgentName, type SessionRow, type AttachPlan } from '../attach.js';
import {
  createHerdrClient,
  discoverHerdrSocket,
  HerdrUnreachableError,
  HerdrRejectedError,
  type HerdrPane,
} from '../herdr.js';

// Exactly two classes may become a degrade. Anything else is a genuine bug and
// must reach the client as a 500 — widening the guard from one class to two
// must not widen it to "anything".
function isHerdrError(err: unknown): boolean {
  return err instanceof HerdrUnreachableError || err instanceof HerdrRejectedError;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      // Held because `panes = null` erases WHICH class failed: resolveAttach
      // sees only the null and always answers `herdr_unreachable`. Without this
      // local, a refusal at pane.list would report the wrong cause at the
      // bottom of the handler — 2.a's exact bug, one layer up.
      let listPanesError: unknown = null;
      if (client) {
        try {
          panes = await client.listPanes();
        } catch (err) {
          if (!isHerdrError(err)) throw err;
          request.log.warn({ err }, 'herdr listPanes failed; degrading');
          listPanesError = err;
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
          if (!isHerdrError(err)) throw err;
          request.log.warn({ err }, 'herdr focusPane failed; degrading');
          reply.send({
            action: 'degraded',
            ...withHerdrCause(stripKind(degradeFallback(session)), err),
          });
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
          if (!isHerdrError(err)) throw err;
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
            } catch (cleanupErr) {
              // Best-effort cleanup must never turn a degrade into a 500, so
              // the failure is swallowed here — but it must not be silent:
              // log it so an orphaned tab can still be traced.
              request.log.warn({ err: cleanupErr }, 'orphaned tab cleanup failed');
            }
          }
          reply.send({
            action: 'degraded',
            ...withHerdrCause(stripKind(degradeFallback(session)), err),
          });
          return;
        }
      }

      reply.send({ action: 'degraded', ...withHerdrCause(stripKind(plan), listPanesError) });
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

type DegradeBody = ReturnType<typeof stripKind> & {
  herdr_code?: string;
  herdr_message?: string;
};

// Replaces the generic `herdr_unreachable` with the true cause, and carries
// Herdr's own code and message through verbatim, when the step that failed was
// a REJECTION rather than a silence.
//
// Only `herdr_unreachable` is overridden. `foreign_host`, `no_project_path` and
// `not_resumable_platform` are decided without Herdr's help and stay true no
// matter what Herdr did — a foreign-host session is still on another machine
// even if pane.list also happened to be refused.
function withHerdrCause(body: DegradeBody, err: unknown): DegradeBody {
  if (!(err instanceof HerdrRejectedError)) return body;
  if (body.reason !== 'herdr_unreachable') return body;
  return {
    ...body,
    reason: 'herdr_rejected',
    herdr_code: err.code,
    herdr_message: err.message,
  };
}
