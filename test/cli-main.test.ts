// test/cli-main.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { main } from '../src/cli/sm.js';
import { ApiError } from '../src/cli/api.js';
import type { ListResponse, SessionSummary } from '../src/cli/api.js';

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'id-default',
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

const list = (sessions: SessionSummary[]): ListResponse => ({
  sessions,
  noise_hidden: 0,
  herdr: 'ok',
});

function deps(over: Record<string, unknown> = {}) {
  return {
    listSessions: vi.fn(async () => list([session()])),
    attachSession: vi.fn(async () => ({
      action: 'focused' as const,
      pane_id: 'w9:p1',
      workspace_id: 'w9',
    })),
    pick: vi.fn(async () => 1 as number | null),
    out: vi.fn(),
    err: vi.fn(),
    ...over,
  } as any;
}

const joined = (fn: any) => fn.mock.calls.map((c: any[]) => String(c[0])).join('\n');

describe('main', () => {
  beforeEach(() => vi.clearAllMocks());

  it('attaches the row the displayed number points at', async () => {
    const d = deps({
      listSessions: vi.fn(async () =>
        list([session({ id: 'first' }), session({ id: 'second' }), session({ id: 'third' })])
      ),
      pick: vi.fn(async () => 3),
    });

    await main([], d);

    // The list is 1-based on screen and the array is 0-based in memory. Getting
    // this wrong resumes a DIFFERENT session than the one John chose, silently
    // and every single time — this project's version of focusing a stranger's
    // pane. `sessions[n]` would attach nothing at all for the last row and the
    // wrong row for every other.
    expect(d.attachSession).toHaveBeenCalledWith('third');
  });

  it('does nothing at all when the pick is cancelled', async () => {
    const d = deps({ pick: vi.fn(async () => null) });

    const code = await main([], d);

    // Enter on an empty prompt is "never mind", not "row 1". Defaulting to the
    // first row would resume a session on a keystroke John used to back out.
    expect(code).toBe(0);
    expect(d.attachSession).not.toHaveBeenCalled();
  });

  it('says so and stops when nothing matches', async () => {
    const d = deps({ listSessions: vi.fn(async () => list([])) });

    const code = await main(['nonexistent'], d);

    expect(code).toBe(0);
    expect(joined(d.out)).toMatch(/no matching sessions/i);
    // Prompting for a number when there are no numbers to pick leaves John
    // typing into a question the tool cannot answer.
    expect(d.pick).not.toHaveBeenCalled();
    expect(d.attachSession).not.toHaveBeenCalled();
  });

  it('reports a bad token on stderr and exits nonzero', async () => {
    const d = deps({
      listSessions: vi.fn(async () => {
        throw new ApiError(401, 'GET /api/sessions → 401');
      }),
    });

    const code = await main([], d);

    // Swallowing this and exiting 0 would print an empty list and let John
    // conclude he has no sessions. The failure is the picker's own, so unlike
    // a degrade it genuinely is nonzero.
    expect(code).toBe(1);
    expect(joined(d.err)).toMatch(/token/i);
    expect(d.out).not.toHaveBeenCalled();
  });

  it('reports an unreachable service distinctly from a rejected request', async () => {
    const d = deps({
      listSessions: vi.fn(async () => {
        throw new ApiError(0, 'Cannot reach http://vps8-core:3000: fetch failed');
      }),
    });

    const code = await main([], d);

    expect(code).toBe(1);
    // "Nothing is listening" and "your token is wrong" send John to different
    // places. Collapsing them into one message wastes the split that api.ts
    // went to the trouble of making.
    expect(joined(d.err)).toMatch(/service|running|reach/i);
    expect(joined(d.err)).not.toMatch(/token/i);
  });

  it('passes the parsed filter and --all through to the list call', async () => {
    const d = deps();

    await main(['--all', 'jazz', 'canon'], d);

    // Parsing argv and then ignoring it is a silent failure: the list still
    // renders, just not the one John asked for.
    expect(d.listSessions).toHaveBeenCalledWith({ q: 'jazz canon', all: true });
  });

  it('sends no filter and no noise flag for a bare invocation', async () => {
    const d = deps();

    await main([], d);

    expect(d.listSessions).toHaveBeenCalledWith({ q: undefined, all: false });
  });

  it('prints the rendered outcome and returns its exit code', async () => {
    const d = deps({
      attachSession: vi.fn(async () => ({
        action: 'degraded' as const,
        reason: 'herdr_unreachable' as const,
        command: 'claude --resume abc-123',
      })),
    });

    const code = await main([], d);

    expect(code).toBe(0);
    expect(joined(d.out)).toContain('claude --resume abc-123');
  });

  it('reports an attach failure without pretending the resume worked', async () => {
    const d = deps({
      attachSession: vi.fn(async () => {
        throw new ApiError(500, 'POST /api/sessions/id/attach → 500');
      }),
    });

    const code = await main([], d);

    // A 500 from attach is a real server error, not a degrade — degrades come
    // back as 200s. Rendering it as an outcome would invent a success.
    expect(code).toBe(1);
    expect(d.err).toHaveBeenCalled();
  });
});
