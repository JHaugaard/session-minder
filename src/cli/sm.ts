// src/cli/sm.ts
// The whole tool, wired: args → list → rows → pick → attach → outcome → exit.
// Everything with a decision in it lives in the modules below; this file is
// only the order they happen in, which is why it can be tested without a TTY
// or a network by handing it different deps.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from './args.js';
import { listSessions, attachSession, ApiError } from './api.js';
import { formatList } from './rows.js';
import { renderOutcome } from './outcome.js';
import { pick } from './pick.js';

export interface MainDeps {
  listSessions: typeof listSessions;
  attachSession: typeof attachSession;
  pick: typeof pick;
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultDeps: MainDeps = {
  listSessions,
  attachSession,
  pick,
  out: console.log,
  err: console.error,
};

// The picker's OWN failures — no service, bad token, real server error. These
// are the only nonzero exits; every outcome the server successfully returns,
// degrades included, exits 0.
function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return `Cannot reach the session-minder service — is it running? (${err.message})`;
    if (err.status === 401) return 'Not authorized — check SESSION_MINDER_TOKEN.';
    return `The service returned ${err.status}. ${err.message}`;
  }
  return String((err as Error)?.message ?? err);
}

export async function main(argv: string[], deps: MainDeps = defaultDeps): Promise<number> {
  const { q, all } = parseArgs(argv);

  let response;
  try {
    response = await deps.listSessions({ q, all });
  } catch (err) {
    deps.err(describe(err));
    return 1;
  }

  if (response.sessions.length === 0) {
    // Nothing to number, so nothing to prompt for. Asking anyway leaves John
    // typing into a question the tool cannot answer.
    deps.out('No matching sessions.');
    return 0;
  }

  for (const line of formatList(response, new Date())) deps.out(line);

  const choice = await deps.pick(response.sessions.length);
  if (choice === null) return 0;

  // 1-based on screen, 0-based in memory. The whole tool turns on this line.
  const chosen = response.sessions[choice - 1];

  let result;
  try {
    result = await deps.attachSession(chosen.id);
  } catch (err) {
    // A thrown error from attach is a real failure — degrades come back as
    // 200s and never land here. Rendering it as an outcome would invent a
    // success the server never claimed.
    deps.err(describe(err));
    return 1;
  }

  const outcome = renderOutcome(result, chosen);
  for (const line of outcome.lines) deps.out(line);
  return outcome.exitCode;
}

// Runs only when this file is the process entry point, so importing it from a
// test does not launch the picker.
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
