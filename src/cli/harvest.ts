// src/cli/harvest.ts
// Backfills session titles that Hermes already wrote for itself.
//
// Not a subcommand of `sm`. The picker's grammar is closed on purpose — "the
// picker resumes, it does not administer" (src/cli/args.ts) — and this
// administers. Separate entry point, same client posture: reads a foreign
// store, writes through the HTTP API, never touches our database.
//
// DRY RUN IS THE DEFAULT. It prints every title it would write and changes
// nothing. `--apply` is the only thing that writes. That is not caution for
// its own sake: this proposes ~48 names in one go, and a list you approve
// without reading is not curation.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { putTitle, supportsIfAbsent, ApiError } from './api.js';
import { discoverStateDbs, collectHermesTitles, type Collected } from './hermes-state.js';

export interface HarvestDeps {
  discover: () => string[];
  collect: (paths: string[]) => Collected;
  putTitle: typeof putTitle;
  supportsIfAbsent: typeof supportsIfAbsent;
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultDeps: HarvestDeps = {
  discover: () => discoverStateDbs(),
  collect: (paths) => collectHermesTitles(paths),
  putTitle,
  supportsIfAbsent,
  out: console.log,
  err: console.error,
};

// The title route's own cap. Checked here so an over-long title is reported as
// one skipped row against a named limit, rather than as an opaque 400 in the
// middle of a run. (Measured 2026-08-14: Hermes' longest title was 56, so this
// is a guard against drift, not a live problem.)
const MAX_TITLE = 60;

// Hermes stamps scheduled runs with a `cron_` id. 118 of the 408 titles on
// disk are these — one "Foundry Morning Digest · Aug 01 06:31" per day, per
// job. They are machine output, not sessions John worked in, and they are
// precisely what this repo's noise_flag concept is for.
function isCronRun(externalSessionId: string): boolean {
  return externalSessionId.startsWith('cron_');
}

// Hermes' titler sometimes stores its own reasoning instead of a title. Seen
// live 2026-08-14: '<think> The user is asking...', '## Enabling Browser
// Automation...', and multi-line prose. The long ones trip the 60-char guard
// by luck; a short one would not, and would land in the picker looking like
// something John typed.
function looksGenerated(title: string): boolean {
  return /<think>/i.test(title) || /^(#{1,6}\s|\*\*)/.test(title) || /[\r\n]/.test(title);
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return `cannot reach the service (${err.message})`;
    if (err.status === 401) return 'not authorized — check SESSION_MINDER_TOKEN';
    return `service returned ${err.status}`;
  }
  return String((err as Error)?.message ?? err);
}

export async function main(argv: string[], deps: HarvestDeps = defaultDeps): Promise<number> {
  const apply = argv.includes('--apply');
  const unknown = argv.filter((a) => a !== '--apply');
  if (unknown.length > 0) {
    deps.err(`Unknown argument: ${unknown[0]}\nUsage: harvest [--apply]`);
    return 1;
  }

  const paths = deps.discover();
  if (paths.length === 0) {
    deps.err('No Hermes state databases found under ~/.hermes — nothing to harvest.');
    return 1;
  }
  deps.out(`Reading ${paths.length} Hermes ${paths.length === 1 ? 'store' : 'stores'}.`);

  const { titles, unreadable, collisions } = deps.collect(paths);

  for (const u of unreadable) deps.err(`Could not read ${u.path}: ${u.error}`);
  for (const c of collisions) {
    deps.err(`Two titles for ${c.external_session_id} — kept "${c.kept}", ignored "${c.discarded}"`);
  }

  let cronSkipped = 0;
  let generatedSkipped = 0;
  let tooLong = 0;
  const usable = titles.filter((t) => {
    if (isCronRun(t.external_session_id)) {
      cronSkipped += 1;
      return false;
    }
    if (looksGenerated(t.title)) {
      generatedSkipped += 1;
      return false;
    }
    if (t.title.length > MAX_TITLE) {
      tooLong += 1;
      return false;
    }
    return true;
  });

  // Counted, not listed. Listing 118 cron rows is how a dry run stops being
  // read — but a silent filter is how you never find out it was wrong.
  const dropped: string[] = [];
  if (cronSkipped > 0) dropped.push(`${cronSkipped} cron runs`);
  if (generatedSkipped > 0) dropped.push(`${generatedSkipped} with generated-looking titles`);
  if (tooLong > 0) dropped.push(`${tooLong} over the ${MAX_TITLE}-char limit`);
  if (dropped.length > 0) deps.out(`Skipped ${dropped.join(', ')}.`);

  if (usable.length === 0) {
    deps.out('Hermes has no titles to offer.');
    return 0;
  }

  // Stable, grouped by the store it came from — which profile named a session
  // is the context that makes the list scannable.
  const sorted = [...usable].sort(
    (a, b) => a.source.localeCompare(b.source) || a.title.localeCompare(b.title)
  );

  if (!apply) {
    deps.out(`\nWould set ${sorted.length} titles:\n`);
    let store = '';
    for (const t of sorted) {
      if (t.source !== store) {
        store = t.source;
        deps.out(`  ${store}`);
      }
      deps.out(`    ${t.external_session_id}  ${t.title}`);
    }
    // Honest about what this list is. Hermes remembers far more sessions than
    // session-minder captured (408 titles on disk against 66 captured Hermes
    // rows, measured 2026-08-14), and a client holding only the join key
    // cannot tell which is which — the sessions list deliberately does not
    // return external_session_id. So this over-lists, and says so, rather than
    // implying every line will be written.
    deps.out(
      `\nNothing written. Only sessions session-minder captured will be titled;` +
        `\nthe rest are reported as "not captured". Sessions already named are left alone.` +
        `\nRe-run with --apply to write these.`
    );
    return 0;
  }

  // Before any write. The guard is the only thing making a re-run safe, and a
  // service that predates it accepts the flag, ignores it, and reports success
  // on every overwrite.
  let guarded: boolean;
  try {
    guarded = await deps.supportsIfAbsent();
  } catch (err) {
    deps.err(`Could not reach the service to check for the if_absent guard: ${describe(err)}`);
    return 1;
  }
  if (!guarded) {
    deps.err(
      'The running service does not implement the if_absent guard, so this would\n' +
        'overwrite titles instead of filling in blanks. Restart session-minder to\n' +
        'pick up the current source, then re-run. Nothing was written.'
    );
    return 1;
  }

  let titled = 0;
  let alreadyNamed = 0;
  let notCaptured = 0;
  let failed = 0;

  for (const t of sorted) {
    try {
      const res = await deps.putTitle({
        platform: 'hermes',
        external_session_id: t.external_session_id,
        title: t.title,
        // The whole reason a re-run is safe. Without it this flattens every
        // name John has written since the last harvest.
        if_absent: true,
      });
      if (res.applied) {
        titled += 1;
        deps.out(`  titled   ${t.external_session_id}  ${t.title}`);
      } else {
        alreadyNamed += 1;
      }
    } catch (err) {
      // Hermes remembers far more sessions than we captured; a 404 is the
      // normal case for anything predating the hooks, not a failure.
      if (err instanceof ApiError && err.status === 404) {
        notCaptured += 1;
        continue;
      }
      failed += 1;
      deps.err(`  FAILED   ${t.external_session_id}: ${describe(err)}`);
    }
  }

  deps.out(
    `\n${titled} titled, ${alreadyNamed} already named, ` +
      `${notCaptured} not captured by session-minder, ${failed} failed.`
  );
  return failed > 0 ? 1 : 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(describe(err));
      process.exit(1);
    }
  );
}
