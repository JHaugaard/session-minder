// src/cli/api.ts
// The picker's only door to the outside world. `sm` is an HTTP client of the
// service and nothing more — no database handle, no Herdr socket, no import
// from a server module. That boundary is what lets it run unchanged from any
// tailnet machine.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolved against THIS MODULE, never against process.cwd(). `sm` is an alias
// John runs from wherever he happens to be standing; a cwd-relative path would
// work only from the repo directory, which is the one place he never needs it.
export const ENV_FILE = fileURLToPath(new URL('../../.env.local', import.meta.url));

// `status: 0` means the request never reached the service at all (connection
// refused, DNS failure, socket timeout). Every other value is a real HTTP
// status. The caller needs the two apart: "nothing is listening" and "the
// service said no" call for different sentences.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface SessionSummary {
  id: string;
  platform: 'claude_code' | 'hermes' | 'kimi_code';
  title: string | null;
  project_path: string | null;
  host: string;
  foreign: boolean;
  started_at: string;
  ended_at: string | null;
  message_count: number | null;
  hermes_surface: string | null;
  live: boolean | null;
}

export interface ListResponse {
  sessions: SessionSummary[];
  noise_hidden: number;
  herdr: 'ok' | 'unreachable' | 'rejected';
}

// Transcribed from src/routes/attach.ts, which is the source of truth for these
// shapes. A degrade is a 200 with a recovery path, not an error — the union
// says so structurally.
export type AttachResponse =
  | { action: 'focused'; pane_id: string; workspace_id: string }
  | { action: 'spawned'; pane_id: string; tab_id: string; argv: string[] }
  | {
      action: 'degraded';
      reason:
        | 'herdr_unreachable'
        | 'herdr_rejected'
        | 'foreign_host'
        | 'not_resumable_platform'
        | 'no_project_path';
      command: string | null;
      herdr_code?: string;
      herdr_message?: string;
    };

// Ten lines, no dependency. Quoting is unsupported on purpose: nothing in this
// repo's .env.local is quoted, and a half-correct quote parser is worse than
// none.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    // First `=` only: postgres URLs carry `=` in query parameters and tokens
    // carry it as base64 padding.
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function readEnvFileOrNull(): string | null {
  try {
    return readFileSync(ENV_FILE, 'utf8');
  } catch {
    // Absent or unreadable is a normal case — the environment may well supply
    // everything, and on another tailnet machine there is no repo at all.
    return null;
  }
}

export interface CliConfig {
  baseUrl: string;
  token: string;
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  readEnvFile: () => string | null = readEnvFileOrNull
): CliConfig {
  let baseUrl = env.SESSION_MINDER_URL;
  let token = env.SESSION_MINDER_TOKEN;

  // Consulted only for what the environment did not answer — and per-variable,
  // so a one-off `SESSION_MINDER_URL=... sm` override works without the file
  // fighting it.
  if (!baseUrl || !token) {
    const text = readEnvFile();
    if (text) {
      const fromFile = parseEnvFile(text);
      baseUrl = baseUrl || fromFile.SESSION_MINDER_URL;
      token = token || fromFile.SESSION_MINDER_TOKEN;
    }
  }

  const missing: string[] = [];
  if (!baseUrl) missing.push('SESSION_MINDER_URL');
  if (!token) missing.push('SESSION_MINDER_TOKEN');
  // `!baseUrl || !token` rather than `missing.length > 0`: same condition, but
  // this form is the one that narrows both to `string` for the return below.
  if (!baseUrl || !token) {
    // Naming the variables and the file is the whole value of this error. The
    // alternative is a fetch against `undefined/api/sessions`, which sends the
    // reader to debug the service instead of their config.
    throw new Error(
      `Missing ${missing.join(' and ')} — set in the environment or in ${ENV_FILE}`
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

async function send(url: URL, init: RequestInit, token: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new ApiError(0, `Cannot reach ${url.origin}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    // Deliberately not parsing the body as success. An error body has no
    // `sessions` key, so returning it would crash the picker on undefined
    // rather than telling the user what went wrong.
    throw new ApiError(res.status, `${init.method ?? 'GET'} ${url.pathname} → ${res.status}`);
  }
  return res.json();
}

export async function listSessions(
  opts: { q?: string; all?: boolean },
  config: CliConfig = resolveConfig()
): Promise<ListResponse> {
  const url = new URL('/api/sessions', config.baseUrl);
  // URLSearchParams encodes; interpolation does not. A bare `&` in the filter
  // would otherwise start a new query parameter and swallow the rest.
  if (opts.q) url.searchParams.set('q', opts.q);
  if (opts.all) url.searchParams.set('noise', 'true');
  return (await send(url, { method: 'GET' }, config.token)) as ListResponse;
}

export async function attachSession(
  id: string,
  config: CliConfig = resolveConfig()
): Promise<AttachResponse> {
  const url = new URL(`/api/sessions/${id}/attach`, config.baseUrl);
  return (await send(url, { method: 'POST' }, config.token)) as AttachResponse;
}
