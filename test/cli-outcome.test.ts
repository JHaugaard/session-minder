// test/cli-outcome.test.ts
import { describe, it, expect } from 'vitest';
import { renderOutcome } from '../src/cli/outcome.js';
import type { AttachResponse, SessionSummary } from '../src/cli/api.js';

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: '11111111-2222-3333-4444-555555555555',
  platform: 'claude_code',
  title: null,
  project_path: '/home/john/dev/wayfinder',
  host: 'vps8-core',
  foreign: false,
  started_at: '2026-08-10T09:00:00Z',
  ended_at: '2026-08-10T10:00:00Z',
  message_count: 42,
  hermes_surface: null,
  live: false,
  ...over,
});

const render = (r: AttachResponse, s = session()) => renderOutcome(r, s);
const text = (r: AttachResponse, s = session()) => render(r, s).lines.join('\n');
// A command is copyable only if it occupies a line by itself — that is the
// assertion, not merely that the string appears somewhere.
const onItsOwnLine = (r: AttachResponse, command: string, s = session()) =>
  render(r, s).lines.some((l) => l.trim() === command);

const COMMAND = 'claude --resume abc-123';

describe('renderOutcome', () => {
  it('names the pane it jumped to when focused', () => {
    expect(text({ action: 'focused', pane_id: 'w9:p1', workspace_id: 'w9' })).toContain('w9:p1');
  });

  it('carries the standing gate caveat on every spawn', () => {
    const out = text({
      action: 'spawned',
      pane_id: 'w9:pC',
      tab_id: 'w9:t2',
      argv: ['claude', '--resume', 'abc-123'],
    });

    // `spawned` means the pane exists, not that the session is ready — Kimi
    // was observed live sitting at "Trust this folder?". Dropping the caveat
    // makes the tool claim success for a pane that is waiting on John.
    expect(out).toContain('w9:pC');
    expect(out).toMatch(/waiting at a prompt/);
  });

  it('says Herdr is down, with the command to paste, when unreachable', () => {
    const r: AttachResponse = {
      action: 'degraded',
      reason: 'herdr_unreachable',
      command: COMMAND,
    };
    expect(text(r)).toMatch(/can't be reached/);
    expect(onItsOwnLine(r, COMMAND)).toBe(true);
  });

  it('recognises agent_name_taken by its code, not by Herdr message text', () => {
    const r: AttachResponse = {
      action: 'degraded',
      reason: 'herdr_rejected',
      command: COMMAND,
      herdr_code: 'agent_name_taken',
      // Deliberately unlike anything a text match would look for. Herdr's
      // wording is Herdr's to change at any release; the code is the contract.
      // Matching on prose means the honest Hermes answer silently degenerates
      // into the generic one the first time Herdr rewrites a sentence.
      herdr_message: 'zzz totally different wording zzz',
    };

    expect(text(r)).toMatch(/running in another pane already/);
    expect(onItsOwnLine(r, COMMAND)).toBe(true);
  });

  it('shows Herdr its own words verbatim for any other rejection', () => {
    const r: AttachResponse = {
      action: 'degraded',
      reason: 'herdr_rejected',
      command: COMMAND,
      herdr_code: 'invalid_agent_name',
      herdr_message: 'name must match ^[a-z][a-z0-9_-]{0,31}$',
    };

    // Showing Herdr's message is the entire point of Task 1's split. Swallowing
    // it here would leave John with "Herdr refused." and nothing to act on —
    // the 2.a experience, reproduced at the last possible layer.
    expect(text(r)).toContain('name must match ^[a-z][a-z0-9_-]{0,31}$');
    expect(onItsOwnLine(r, COMMAND)).toBe(true);
  });

  it('names the machine a foreign session belongs to', () => {
    const r: AttachResponse = { action: 'degraded', reason: 'foreign_host', command: COMMAND };
    expect(text(r, session({ host: 'mbp', foreign: true }))).toContain('mbp');
    expect(onItsOwnLine(r, COMMAND, session({ host: 'mbp', foreign: true }))).toBe(true);
  });

  it('explains a missing project directory', () => {
    const r: AttachResponse = { action: 'degraded', reason: 'no_project_path', command: COMMAND };
    expect(text(r)).toMatch(/no recorded project directory/i);
    expect(onItsOwnLine(r, COMMAND)).toBe(true);
  });

  it('admits when a session cannot be resumed at all', () => {
    const out = text({
      action: 'degraded',
      reason: 'not_resumable_platform',
      command: null,
    });

    // No command exists for this one. Printing an empty line where a command
    // belongs would read as a copyable blank.
    expect(out).toMatch(/can't be resumed/);
    expect(out.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
  });

  it('keeps the command on its own line, never inside the sentence', () => {
    const r: AttachResponse = {
      action: 'degraded',
      reason: 'herdr_unreachable',
      command: COMMAND,
    };
    const { lines } = render(r);
    const sentence = lines.find((l) => l.includes('reached'))!;

    // A command embedded mid-sentence cannot be double-clicked or copied
    // cleanly, which defeats the only purpose a degrade response has.
    expect(sentence).not.toContain(COMMAND);
    expect(onItsOwnLine(r, COMMAND)).toBe(true);
  });

  it('exits 0 for every server outcome, degrades included', () => {
    // Degrade is a valid answer, not a failure — the 2.a rule carried to the
    // shell. A nonzero exit here would make `sm && something` stop working and
    // would paint an honest fallback red in every wrapper script.
    expect(render({ action: 'focused', pane_id: 'p', workspace_id: 'w' }).exitCode).toBe(0);
    expect(
      render({ action: 'spawned', pane_id: 'p', tab_id: 't', argv: [] }).exitCode
    ).toBe(0);
    expect(
      render({ action: 'degraded', reason: 'herdr_unreachable', command: COMMAND }).exitCode
    ).toBe(0);
    expect(
      render({ action: 'degraded', reason: 'not_resumable_platform', command: null }).exitCode
    ).toBe(0);
  });
});
