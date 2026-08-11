// src/cli/rows.ts
// The picker's display core: pure functions, no clock, no I/O. `now` is always
// a parameter so every boundary in relTime is a test John can read rather than
// a behavior that only appears at 11:59pm.
import type { ListResponse, SessionSummary } from './api.js';

const PLATFORM_LABEL: Record<string, string> = {
  claude_code: 'claude',
  hermes: 'hermes',
  kimi_code: 'kimi',
};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// title → project basename → Hermes surface → a literal. The ratified order:
// a title exists only because John set it deliberately, so it outranks a path
// he never chose. There is deliberately no fallback to `id` — the spec shows
// no UUIDs in this list at all.
export function identity(s: SessionSummary): string {
  if (s.title) return s.title;
  if (s.project_path) {
    const segments = s.project_path.split('/').filter((p) => p !== '');
    if (segments.length > 0) return segments[segments.length - 1];
  }
  if (s.hermes_surface) return `(${s.hermes_surface})`;
  return '(no project)';
}

export function relTime(now: Date, startedAt: string): string {
  const started = new Date(startedAt);
  const minutes = Math.floor((now.getTime() - started.getTime()) / 60000);

  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`;
  // The hours branch runs the full day. Without it a session from this morning
  // reads as a bare date, indistinguishable from one at midnight — in the exact
  // column John scans to find what he was just doing.
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;

  // Calendar comparison, not arithmetic: "yesterday" is a day on the wall, and
  // only reachable once the hours branch has been passed.
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    started.getFullYear() === yesterday.getFullYear() &&
    started.getMonth() === yesterday.getMonth() &&
    started.getDate() === yesterday.getDate()
  ) {
    return 'yesterday';
  }

  return `${MONTHS[started.getMonth()]} ${started.getDate()}`;
}

export function duration(startedAt: string, endedAt: string | null): string {
  // A running session has no length yet. Arithmetic on null gives NaN, and
  // "NaNm" in the column is worse than an honest blank.
  if (endedAt === null) return '—';
  const minutes = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000)
  );
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

type Align = 'left' | 'right';

const LAYOUT: { header: string; align: Align }[] = [
  { header: '#', align: 'right' },
  { header: 'tool', align: 'left' },
  { header: 'project', align: 'left' },
  // The live marker is its own column so a ● never shifts the `when` text out
  // of line with the rows around it.
  { header: '', align: 'left' },
  { header: 'when', align: 'left' },
  { header: 'length', align: 'right' },
  { header: 'msgs', align: 'right' },
];

function layout(rows: string[][]): string[] {
  const widths = LAYOUT.map((col, i) =>
    Math.max(col.header.length, ...rows.map((r) => [...r[i]].length))
  );
  const render = (cells: string[]) =>
    ' ' +
    cells
      .map((cell, i) => {
        // Spread, not .length: `●` and `—` are single glyphs but the em dash
        // is one UTF-16 unit while other display characters need not be.
        const pad = ' '.repeat(Math.max(0, widths[i] - [...cell].length));
        return LAYOUT[i].align === 'right' ? pad + cell : cell + pad;
      })
      .join('  ')
      .trimEnd();
  return [render(LAYOUT.map((c) => c.header)), ...rows.map(render)];
}

export function formatList(response: ListResponse, now: Date): string[] {
  const { sessions, noise_hidden: noiseHidden, herdr } = response;

  const header =
    noiseHidden > 0
      ? `sm — ${sessions.length} resumable sessions (${noiseHidden} noise hidden — sm --all)`
      : `sm — ${sessions.length} resumable sessions`;

  const cells = sessions.map((s, i) => [
    String(i + 1),
    PLATFORM_LABEL[s.platform] ?? s.platform,
    // The host tag rides with the identity because it qualifies WHICH project
    // this is, not when it ran.
    s.foreign ? `${identity(s)}  [${s.host}]` : identity(s),
    // Exactly `true`. `live: null` means Herdr could not answer — a truthiness
    // check would badge every row live whenever Herdr is down, promising a
    // jump that attach will then refuse to make.
    s.live === true ? '●' : '',
    relTime(now, s.started_at),
    duration(s.started_at, s.ended_at),
    s.message_count === null ? '—' : String(s.message_count),
  ]);

  const lines = ['', header, '', ...layout(cells), ''];

  lines.push(' ● = live in a Herdr pane now — picking it jumps there.');
  lines.push(' Otherwise picking spawns a freshly resumed pane.');
  // Only explained when a bracket is actually on screen.
  if (sessions.some((s) => s.foreign)) {
    lines.push(' [host] = lives on another machine — picking prints the command to run there.');
  }
  if (herdr !== 'ok') {
    lines.push('');
    lines.push(
      " Herdr can't be reached — live markers unavailable; attach will hand you commands."
    );
  }
  lines.push('');

  return lines;
}
