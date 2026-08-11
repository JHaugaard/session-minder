// test/cli-rows.test.ts
import { describe, it, expect } from 'vitest';
import { identity, relTime, duration, formatList } from '../src/cli/rows.js';
import type { ListResponse, SessionSummary } from '../src/cli/api.js';

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: '11111111-2222-3333-4444-555555555555',
  platform: 'claude_code',
  title: null,
  project_path: '/home/john/dev/active/session-minder',
  host: 'vps8-core',
  foreign: false,
  started_at: '2026-08-10T09:00:00Z',
  ended_at: '2026-08-10T10:00:00Z',
  message_count: 42,
  hermes_surface: null,
  live: false,
  ...over,
});

const response = (over: Partial<ListResponse> = {}): ListResponse => ({
  sessions: [session()],
  noise_hidden: 0,
  herdr: 'ok',
  ...over,
});

// Midday so no assertion below straddles a local-midnight boundary.
const NOW = new Date('2026-08-10T12:00:00Z');

describe('identity', () => {
  it('follows title, then project basename, then Hermes surface, then a literal', () => {
    // Each rung is reached only by knocking out every rung above it — that
    // is what makes this an ORDER test rather than four independent cases.
    const all = { title: 'Phase 2.b picker', hermes_surface: 'telegram' };

    // The chain order is the ruling: a title exists only because John set it
    // deliberately, so it outranks a path he never chose. Reordering to put
    // the basename first would bury every title he ever writes.
    expect(identity(session(all))).toBe('Phase 2.b picker');
    expect(identity(session({ ...all, title: null }))).toBe('session-minder');
    expect(identity(session({ ...all, title: null, project_path: null }))).toBe('(telegram)');
    expect(
      identity(session({ title: null, project_path: null, hermes_surface: null }))
    ).toBe('(no project)');
  });

  it('never shows a UUID', () => {
    // Spec rule: no ids anywhere in the list. A fallback to `id` would look
    // like a reasonable last resort and would put a 36-character UUID in a
    // column meant to be read at a glance.
    const bare = identity(session({ title: null, hermes_surface: null, project_path: null }));
    expect(bare).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it('uses the last path segment even with a trailing slash', () => {
    expect(identity(session({ project_path: '/home/john/dev/wayfinder/' }))).toBe('wayfinder');
  });
});

describe('relTime', () => {
  it('reports minutes under an hour and hours under a day', () => {
    expect(relTime(NOW, '2026-08-10T11:01:00Z')).toBe('59m ago');
    expect(relTime(NOW, '2026-08-10T10:59:00Z')).toBe('1h ago');
  });

  it('keeps the hours branch right up to 24h', () => {
    // Dropping the hours branch sends everything past an hour to a date, so a
    // session from this morning reads "Aug 10" — indistinguishable from one at
    // midnight, in the column John uses to find what he was just doing.
    expect(relTime(NOW, '2026-08-09T13:00:00Z')).toBe('23h ago');
  });

  it('says yesterday only past 24h on the previous calendar day', () => {
    expect(relTime(NOW, '2026-08-09T06:00:00Z')).toBe('yesterday');
  });

  it('falls back to month and day for anything older', () => {
    expect(relTime(NOW, '2026-08-08T09:00:00Z')).toBe('Aug 8');
  });
});

describe('duration', () => {
  it('renders hours and minutes, or minutes alone', () => {
    expect(duration('2026-08-10T06:00:00Z', '2026-08-10T09:40:00Z')).toBe('3h 40m');
    expect(duration('2026-08-10T09:00:00Z', '2026-08-10T09:22:00Z')).toBe('22m');
  });

  it('renders an em dash for a session that never ended', () => {
    // A running session has no length. Arithmetic on null yields NaN, and
    // "NaNm" in the column is worse than an honest blank.
    expect(duration('2026-08-10T09:00:00Z', null)).toBe('—');
  });
});

describe('formatList', () => {
  const text = (r: ListResponse, now = NOW) => formatList(r, now).join('\n');

  it('marks a row live only when live is exactly true', () => {
    const out = text(
      response({
        sessions: [
          session({ id: 'a', live: true }),
          session({ id: 'b', live: false }),
          session({ id: 'c', live: null }),
        ],
      })
    );
    const lines = out.split('\n').filter((l) => /^\s*\d+\s/.test(l));

    // `live: null` means Herdr could not answer, not "yes". A truthiness test
    // (`live != false`) would paint EVERY row live whenever Herdr is down —
    // promising a jump the attach will then refuse to make.
    expect(lines[0]).toContain('●');
    expect(lines[1]).not.toContain('●');
    expect(lines[2]).not.toContain('●');
  });

  it('tags only foreign rows, with their own host', () => {
    const out = text(
      response({
        sessions: [
          session({ id: 'a', foreign: false, host: 'vps8-core' }),
          session({ id: 'b', foreign: true, host: 'mbp' }),
        ],
      })
    );

    // Tagging every row would put a bracket on all five lines and make the
    // one that matters invisible.
    expect(out).toContain('[mbp]');
    expect(out).not.toContain('[vps8-core]');
  });

  it('warns about missing live markers only when Herdr could not answer', () => {
    // Matched on the warning's own sentence, not the word "Herdr" — the ●
    // legend names Herdr too, and always will.
    const WARNING = /live markers unavailable/;
    expect(text(response({ herdr: 'ok' }))).not.toMatch(WARNING);
    expect(text(response({ herdr: 'unreachable' }))).toMatch(WARNING);
    // A warning printed unconditionally is a warning nobody reads — and it
    // would contradict the ● markers sitting right above it.
    expect(text(response({ herdr: 'rejected' }))).toMatch(WARNING);
  });

  it('mentions hidden noise and the --all hint only when something is hidden', () => {
    const withNoise = text(response({ noise_hidden: 18 }));
    expect(withNoise).toContain('18 noise hidden');
    expect(withNoise).toContain('sm --all');

    // "0 noise hidden — sm --all" on every invocation is clutter offering a
    // flag that would change nothing.
    const without = text(response({ noise_hidden: 0 }));
    expect(without).not.toContain('noise hidden');
    expect(without).not.toContain('sm --all');
  });

  it('shortens platform names for the tool column', () => {
    const out = text(
      response({
        sessions: [
          session({ id: 'a', platform: 'claude_code' }),
          session({ id: 'b', platform: 'kimi_code' }),
          session({ id: 'c', platform: 'hermes' }),
        ],
      })
    );
    expect(out).toContain('claude');
    expect(out).toContain('kimi');
    expect(out).toContain('hermes');
    expect(out).not.toContain('claude_code');
    expect(out).not.toContain('kimi_code');
  });

  it('aligns the when column across rows of differing project width', () => {
    const out = formatList(
      response({
        sessions: [
          session({ id: 'a', title: 'x' }),
          session({ id: 'b', title: 'a-much-longer-session-title' }),
        ],
      }),
      NOW
    );
    const dataLines = out.filter((l) => /^\s*\d+\s/.test(l));
    // A one-glance list only works if the eye can run straight down a column.
    expect(dataLines[0].indexOf('ago')).toBe(dataLines[1].indexOf('ago'));
  });

  it('numbers rows from 1 in the order given', () => {
    const out = formatList(
      response({ sessions: [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })] }),
      NOW
    );
    const dataLines = out.filter((l) => /^\s*\d+\s/.test(l));
    // The number is what John types. Zero-basing it here while the picker
    // indexes 1-based (or vice versa) resumes the wrong session silently.
    expect(dataLines.map((l) => l.trim().split(/\s+/)[0])).toEqual(['1', '2', '3']);
  });
});
