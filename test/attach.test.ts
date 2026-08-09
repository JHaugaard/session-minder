// test/attach.test.ts
import { describe, it, expect } from 'vitest';
import { resolveAttach, type SessionRow } from '../src/attach.js';
import type { HerdrPane } from '../src/herdr.js';

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 'row-uuid',
  platform: 'claude_code',
  external_session_id: 'abc-123',
  host: 'vps8-core',
  project_path: '/home/john/dev/wayfinder',
  ended_at: new Date(),
  ...over,
});

const pane = (over: Partial<HerdrPane> = {}): HerdrPane => ({
  pane_id: 'w9:p1',
  workspace_id: 'w9',
  tab_id: 'w9:t1',
  cwd: '/home/john/dev/wayfinder',
  agent: 'claude',
  agent_session: {
    source: 'herdr:claude',
    agent: 'claude',
    kind: 'id',
    value: 'abc-123',
  },
  ...over,
});

describe('resolveAttach', () => {
  it('focuses the live pane whose agent_session matches external_session_id', () => {
    const plan = resolveAttach({
      session: session(),
      panes: [pane()],
      localHost: 'vps8-core',
    });

    // Pins the join rule that the whole phase rests on: the match is on
    // agent_session.value == external_session_id, NOT on cwd or agent kind.
    expect(plan).toEqual({ kind: 'focus', pane_id: 'w9:p1', workspace_id: 'w9' });
  });

  it('does not match a pane whose cwd is right but whose session id differs', () => {
    const plan = resolveAttach({
      session: session(),
      panes: [pane({ agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: 'a-different-uuid' } })],
      localHost: 'vps8-core',
    });

    // Pins the negative half of the join rule. A cwd-based fallback would
    // focus the WRONG session — the failure this endpoint must never make.
    expect(plan.kind).toBe('spawn');
  });

  it('treats a pane with no agent_session as not live', () => {
    const plan = resolveAttach({
      session: session(),
      panes: [pane({ agent_session: undefined })],
      localHost: 'vps8-core',
    });

    // Pins the spike finding: panes whose agent started before the Herdr
    // integration was installed have no agent_session. That is "not live",
    // never an error.
    expect(plan.kind).toBe('spawn');
  });

  it('spawns a resume pane for an ended claude_code session', () => {
    const plan = resolveAttach({
      session: session(),
      panes: [],
      localHost: 'vps8-core',
    });

    expect(plan).toEqual({
      kind: 'spawn',
      cwd: '/home/john/dev/wayfinder',
      agent_kind: 'claude',
      args: ['--resume', 'abc-123'],
      command: 'claude --resume abc-123',
    });
  });

  it('degrades with herdr_unreachable when panes is null', () => {
    const plan = resolveAttach({
      session: session(),
      panes: null,
      localHost: 'vps8-core',
    });

    // Pins the fallback contract: even with Herdr gone, the caller still gets
    // a usable copyable command — the dashboard's v1 behavior survives.
    expect(plan).toEqual({
      kind: 'degrade',
      reason: 'herdr_unreachable',
      command: 'claude --resume abc-123',
    });
  });

  it('degrades for a session captured on another host', () => {
    const plan = resolveAttach({
      session: session({ host: 'mbp' }),
      panes: [pane()],
      localHost: 'vps8-core',
    });

    // Pins the server-locality guard: the Herdr socket is local, so a session
    // from mbp can never be attached here even if an id somehow matched.
    expect(plan).toEqual({
      kind: 'degrade',
      reason: 'foreign_host',
      command: 'claude --resume abc-123',
    });
  });

  it('spawns a resume pane for an ended hermes session', () => {
    const plan = resolveAttach({
      session: session({ platform: 'hermes', external_session_id: '20260808_132446_ca4215' }),
      panes: [],
      localHost: 'vps8-core',
    });

    expect(plan).toEqual({
      kind: 'spawn',
      cwd: '/home/john/dev/wayfinder',
      agent_kind: 'hermes',
      args: ['--resume', '20260808_132446_ca4215'],
      command: 'hermes --resume 20260808_132446_ca4215',
    });
  });

  it('spawns a resume pane for an ended kimi_code session, id passed through verbatim', () => {
    const plan = resolveAttach({
      session: session({
        platform: 'kimi_code',
        external_session_id: 'session_5890019f-d377-4187-b14a-2fd406dd32c7',
      }),
      panes: [],
      localHost: 'vps8-core',
    });

    // Pins the id-passthrough rule: Kimi's own session directories are named
    // `session_<uuid>`, so the `session_` prefix is PART of the id, not noise
    // to be stripped. Stripping it would produce a command that fails to find
    // the session while looking perfectly reasonable.
    expect(plan).toEqual({
      kind: 'spawn',
      cwd: '/home/john/dev/wayfinder',
      agent_kind: 'kimi',
      args: ['--session', 'session_5890019f-d377-4187-b14a-2fd406dd32c7'],
      command: 'kimi --session session_5890019f-d377-4187-b14a-2fd406dd32c7',
    });
  });

  it('degrades with no command for a platform that has no resume spec', () => {
    const plan = resolveAttach({
      // Cast: the DB CHECK constraint allows only the three real platforms, so
      // this branch is a safety net for a fourth being added without a resume
      // spec. Pins that the net exists rather than crashing on a lookup miss.
      session: session({ platform: 'future_agent' as unknown as SessionRow['platform'] }),
      panes: [],
      localHost: 'vps8-core',
    });

    expect(plan).toEqual({
      kind: 'degrade',
      reason: 'not_resumable_platform',
      command: null,
    });
  });

  it('degrades when an ended session has no project_path', () => {
    const plan = resolveAttach({
      session: session({ project_path: null }),
      panes: [],
      localHost: 'vps8-core',
    });

    // Pins the spawn precondition: tab.create requires a cwd. Many Hermes and
    // cron sessions have none.
    expect(plan).toEqual({
      kind: 'degrade',
      reason: 'no_project_path',
      command: 'claude --resume abc-123',
    });
  });

  it('focuses a live session even when it is captured on a foreign host? no — host wins', () => {
    const plan = resolveAttach({
      session: session({ host: 'mini' }),
      panes: [pane()],
      localHost: 'vps8-core',
    });

    // Ordering matters: the host guard is checked BEFORE the pane join, so a
    // stale id collision across machines can never focus a local pane.
    expect(plan.kind).toBe('degrade');
  });
});
