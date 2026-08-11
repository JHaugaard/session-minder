// test/cli-api.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  ApiError,
  parseEnvFile,
  resolveConfig,
  listSessions,
  attachSession,
  ENV_FILE,
} from '../src/cli/api.js';

// The repo root as seen from THIS test file. Used to state where .env.local
// must resolve to without hard-coding an absolute path.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const okJson = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

describe('resolveConfig', () => {
  it('prefers the environment over the env file', () => {
    // The file must not even be consulted when the environment answers —
    // asserted by making the reader throw. `sm` has to honor a one-off
    // SESSION_MINDER_URL=... override without editing a file.
    const config = resolveConfig(
      { SESSION_MINDER_URL: 'http://from-env:3000', SESSION_MINDER_TOKEN: 'env-token' },
      () => {
        throw new Error('env file must not be read when the environment answers');
      }
    );

    expect(config).toEqual({ baseUrl: 'http://from-env:3000', token: 'env-token' });
  });

  it('falls back to the env file for whichever variable the environment lacks', () => {
    const config = resolveConfig(
      { SESSION_MINDER_TOKEN: 'env-token' },
      () => 'SESSION_MINDER_URL=http://from-file:3000\nSESSION_MINDER_TOKEN=file-token\n'
    );

    // Per-variable precedence, not all-or-nothing: the env supplies the token,
    // the file supplies the URL.
    expect(config).toEqual({ baseUrl: 'http://from-file:3000', token: 'env-token' });
  });

  it('throws naming both variables when neither source supplies them', () => {
    // A CLI that fails with "fetch failed" against `undefined/api/sessions`
    // sends John debugging the service instead of his config.
    expect(() => resolveConfig({}, () => null)).toThrow(/SESSION_MINDER_URL/);
    expect(() => resolveConfig({}, () => null)).toThrow(/SESSION_MINDER_TOKEN/);
  });
});

describe('ENV_FILE', () => {
  it('resolves against the module, not the working directory', async () => {
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      vi.resetModules();
      const fresh = await import('../src/cli/api.js');

      // `sm` is an alias run from wherever John happens to be standing. A path
      // resolved against process.cwd() works only from the repo directory —
      // which is every directory except the ones he actually uses it in.
      expect(fresh.ENV_FILE).toBe(join(REPO_ROOT, '.env.local'));
      expect(fresh.ENV_FILE).not.toBe(join(tmpdir(), '.env.local'));
    } finally {
      process.chdir(original);
    }
  });

  it('points at the repo .env.local', () => {
    expect(ENV_FILE).toBe(join(REPO_ROOT, '.env.local'));
  });
});

describe('parseEnvFile', () => {
  it('reads KEY=value lines and ignores comments and blanks', () => {
    const parsed = parseEnvFile(
      '# a comment\n\nSESSION_MINDER_URL=http://vps8-core:3000\n  \nOTHER=x\n'
    );
    expect(parsed.SESSION_MINDER_URL).toBe('http://vps8-core:3000');
    expect(parsed.OTHER).toBe('x');
  });

  it('splits on the first = so values may contain more', () => {
    // Real values do: postgres URLs carry `=` in query parameters, and tokens
    // are base64 with `=` padding. Splitting on every `=` truncates them.
    const parsed = parseEnvFile('DATABASE_URL=postgres://u:p@h/db?sslmode=require\n');
    expect(parsed.DATABASE_URL).toBe('postgres://u:p@h/db?sslmode=require');
  });
});

describe('listSessions / attachSession', () => {
  const saved = { url: process.env.SESSION_MINDER_URL, token: process.env.SESSION_MINDER_TOKEN };

  beforeEach(() => {
    process.env.SESSION_MINDER_URL = 'http://vps8-core:3000';
    process.env.SESSION_MINDER_TOKEN = 'test-token-123';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved.url === undefined) delete process.env.SESSION_MINDER_URL;
    else process.env.SESSION_MINDER_URL = saved.url;
    if (saved.token === undefined) delete process.env.SESSION_MINDER_TOKEN;
    else process.env.SESSION_MINDER_TOKEN = saved.token;
  });

  it('sends the bearer token on every request', async () => {
    const fetchMock = okJson({ sessions: [], noise_hidden: 0, herdr: 'ok' });
    vi.stubGlobal('fetch', fetchMock);

    await listSessions({});
    await attachSession('11111111-2222-3333-4444-555555555555');

    // Both verbs, not just the read. Dropping the header on either turns every
    // invocation into a 401 the user cannot distinguish from a bad token.
    for (const [, init] of fetchMock.mock.calls as any[]) {
      expect(init.headers.Authorization).toBe('Bearer test-token-123');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('URL-encodes the filter instead of interpolating it raw', async () => {
    const fetchMock = okJson({ sessions: [], noise_hidden: 0, herdr: 'ok' });
    vi.stubGlobal('fetch', fetchMock);

    await listSessions({ q: 'jazz canon & more' });

    const url = String((fetchMock.mock.calls[0] as any)[0]);
    // A raw interpolation breaks on the first space or `&` John types — the
    // `&` would start a new query parameter and the tail of his filter would
    // vanish without a word.
    expect(url).not.toContain('jazz canon & more');
    expect(new URL(url).searchParams.get('q')).toBe('jazz canon & more');
  });

  it('asks for noise only when --all was given', async () => {
    const fetchMock = okJson({ sessions: [], noise_hidden: 0, herdr: 'ok' });
    vi.stubGlobal('fetch', fetchMock);

    await listSessions({ all: true });
    await listSessions({});

    const withAll = new URL(String((fetchMock.mock.calls[0] as any)[0]));
    const without = new URL(String((fetchMock.mock.calls[1] as any)[0]));
    expect(withAll.searchParams.get('noise')).toBe('true');
    // Absent, not `noise=false`: the route treats anything but the string
    // 'true' as false, but sending a parameter John did not ask for invites a
    // future reader to make it mean something.
    expect(without.searchParams.has('noise')).toBe(false);
    expect(without.searchParams.has('q')).toBe(false);
  });

  it('throws ApiError carrying the status instead of parsing an error body as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }))
    );

    const err = await listSessions({}).catch((e) => e);

    // Returning res.json() unconditionally hands the caller `{error:...}` with
    // no `sessions` key — the picker would then crash on undefined rather than
    // telling John his token is wrong.
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it('reports a network failure as ApiError status 0, distinct from any HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const err = await listSessions({}).catch((e) => e);

    // "The service is not running" and "the service said no" need different
    // sentences. Letting the raw TypeError escape would print `fetch failed`,
    // which names neither.
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it('posts to the attach endpoint for the given id', async () => {
    const fetchMock = okJson({ action: 'focused', pane_id: 'w9:p1', workspace_id: 'w9' });
    vi.stubGlobal('fetch', fetchMock);

    const res = await attachSession('11111111-2222-3333-4444-555555555555');

    const [url, init] = (fetchMock.mock.calls[0] as any);
    expect(String(url)).toBe(
      'http://vps8-core:3000/api/sessions/11111111-2222-3333-4444-555555555555/attach'
    );
    expect(init.method).toBe('POST');
    expect(res).toEqual({ action: 'focused', pane_id: 'w9:p1', workspace_id: 'w9' });
  });
});
