// src/attach.ts
// Pure decision layer: no sockets, no database. Every branch rule from the
// spec's "2.a scope / Attach contract" lives here so it can be tested with
// plain objects.
import type { HerdrPane } from './herdr.js';

export type Platform = 'claude_code' | 'hermes' | 'kimi_code';

export interface SessionRow {
  id: string;
  platform: Platform;
  external_session_id: string;
  host: string;
  project_path: string | null;
  // Carried through for the caller (Task 5's route selects it for display) —
  // deliberately NOT a branch input here. "Live" is defined by a pane match,
  // not by `ended_at IS NULL`. Accepted consequence: a session still running
  // outside any Herdr pane (e.g. a detached process) takes the spawn branch.
  ended_at: Date | null;
}

export type DegradeReason =
  | 'herdr_unreachable'
  | 'foreign_host'
  | 'not_resumable_platform'
  | 'no_project_path';

export type AttachPlan =
  | { kind: 'focus'; pane_id: string; workspace_id: string }
  | { kind: 'spawn'; cwd: string; agent_kind: string; args: string[]; command: string }
  | { kind: 'degrade'; reason: DegradeReason; command: string | null };

// All three platforms are resumable, each verified against its installed
// binary's --help on 2026-08-09. `agentKind` is the Herdr agent manifest name
// (agent.start's `kind`), which is NOT always the same string as our platform
// column — claude_code -> claude, kimi_code -> kimi.
//
// The external_session_id is passed through verbatim in every case. Kimi's own
// session directories are named `session_<uuid>`, so its `session_` prefix is
// part of the id, not a wrapper to strip.
interface ResumeSpec {
  agentKind: string;
  args: (externalSessionId: string) => string[];
  command: (externalSessionId: string) => string;
}

const RESUME: Record<Platform, ResumeSpec> = {
  claude_code: {
    agentKind: 'claude',
    args: (id) => ['--resume', id],
    command: (id) => `claude --resume ${id}`,
  },
  hermes: {
    agentKind: 'hermes',
    args: (id) => ['--resume', id],
    command: (id) => `hermes --resume ${id}`,
  },
  kimi_code: {
    agentKind: 'kimi',
    args: (id) => ['--session', id],
    command: (id) => `kimi --session ${id}`,
  },
};

export function resolveAttach(input: {
  session: SessionRow;
  panes: HerdrPane[] | null;
  localHost: string;
}): AttachPlan {
  const { session, panes, localHost } = input;
  // `as ... | undefined`: the RESUME map is total over Platform, but nothing
  // validates that a DB row's platform column actually landed in that union
  // (the SQL cast is not statically checked), so a lookup miss is still a
  // real runtime possibility — this keeps that safety net.
  const resume = RESUME[session.platform] as ResumeSpec | undefined;
  const command = resume ? resume.command(session.external_session_id) : null;

  // Checked before the pane join on purpose: external_session_id is unique
  // per (platform, id) but two machines could in principle collide, and
  // focusing a local pane for a remote session would be a silent wrong answer.
  if (session.host !== localHost) {
    return { kind: 'degrade', reason: 'foreign_host', command };
  }

  if (panes === null) {
    return { kind: 'degrade', reason: 'herdr_unreachable', command };
  }

  const live = panes.find(
    (p) => p.agent_session?.value === session.external_session_id
  );
  if (live) {
    return { kind: 'focus', pane_id: live.pane_id, workspace_id: live.workspace_id };
  }

  if (!resume) {
    return { kind: 'degrade', reason: 'not_resumable_platform', command: null };
  }

  if (!session.project_path) {
    return { kind: 'degrade', reason: 'no_project_path', command };
  }

  return {
    kind: 'spawn',
    cwd: session.project_path,
    agent_kind: resume.agentKind,
    args: resume.args(session.external_session_id),
    command: resume.command(session.external_session_id),
  };
}
