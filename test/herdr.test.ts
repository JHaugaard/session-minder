// test/herdr.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHerdrClient, HerdrUnreachableError } from '../src/herdr.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

// Stands up a throwaway unix socket that replies with `responder(request)`.
// Records every raw request line so tests can assert on the wire format.
function fakeHerdr(responder: (req: any) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-test-'));
  const socketPath = join(dir, 'herdr.sock');
  const received: any[] = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const req = JSON.parse(line);
        received.push(req);
        conn.write(JSON.stringify(responder(req)) + '\n');
      }
    });
  });
  server.listen(socketPath);
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, received };
}

describe('Herdr socket client', () => {
  it('sends the request id as a JSON string', async () => {
    const { socketPath, received } = fakeHerdr(() => ({
      id: '1',
      result: { type: 'pane_list', panes: [] },
    }));

    await createHerdrClient(socketPath).listPanes();

    // Pins the spike's hard-won trap: Herdr rejects an integer id outright
    // with "invalid type: integer 1, expected a string". A number here would
    // fail every call at runtime while passing any shape-only assertion.
    expect(typeof received[0].id).toBe('string');
    expect(received[0].method).toBe('pane.list');
  });

  it('returns panes including their agent_session join key', async () => {
    const { socketPath } = fakeHerdr(() => ({
      id: '1',
      result: {
        type: 'pane_list',
        panes: [
          {
            pane_id: 'w9:p1',
            workspace_id: 'w9',
            tab_id: 'w9:t1',
            cwd: '/home/john/dev/active/session-minder',
            agent: 'claude',
            agent_session: {
              source: 'herdr:claude',
              agent: 'claude',
              kind: 'id',
              value: '8f7f70ae-9054-45b6-9f07-23e66f3a26b4',
            },
          },
        ],
      },
    }));

    const panes = await createHerdrClient(socketPath).listPanes();

    expect(panes).toHaveLength(1);
    expect(panes[0].agent_session?.value).toBe('8f7f70ae-9054-45b6-9f07-23e66f3a26b4');
  });

  it('throws HerdrUnreachableError when the socket does not exist', async () => {
    const client = createHerdrClient('/nonexistent/herdr.sock');

    // Pins the degrade contract: an absent Herdr must surface as one typed,
    // recognizable error the route can turn into a degrade response — not an
    // arbitrary ENOENT that reaches the client as a 500.
    await expect(client.listPanes()).rejects.toBeInstanceOf(HerdrUnreachableError);
  });

  it('throws HerdrUnreachableError when Herdr returns a protocol error', async () => {
    const { socketPath } = fakeHerdr(() => ({
      id: '',
      error: { code: 'invalid_request', message: 'unknown variant' },
    }));

    await expect(createHerdrClient(socketPath).listPanes()).rejects.toBeInstanceOf(
      HerdrUnreachableError
    );
  });

  it('throws HerdrUnreachableError when the connection closes without a response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-test-'));
    const socketPath = join(dir, 'herdr.sock');
    const server = net.createServer((conn) => {
      // Accept the request but close without ever writing a response —
      // exercises the `close` handler's own fail() path, not the
      // data-then-error or data-then-result paths covered elsewhere.
      conn.on('data', () => conn.end());
    });
    server.listen(socketPath);
    cleanups.push(() => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });

    await expect(createHerdrClient(socketPath).listPanes()).rejects.toBeInstanceOf(
      HerdrUnreachableError
    );
  });

  it('sends pane.focus with the pane_id param', async () => {
    const { socketPath, received } = fakeHerdr(() => ({ id: '1', result: { type: 'ok' } }));

    await createHerdrClient(socketPath).focusPane('w9:p1');

    expect(received[0].method).toBe('pane.focus');
    expect(received[0].params).toEqual({ pane_id: 'w9:p1' });
  });

  it('creates a tab and returns the root pane id', async () => {
    const { socketPath, received } = fakeHerdr(() => ({
      id: '1',
      result: {
        type: 'tab_created',
        tab: { tab_id: 'w9:t2' },
        root_pane: { pane_id: 'w9:p3' },
      },
    }));

    const result = await createHerdrClient(socketPath).createTab({
      cwd: '/home/john/dev/wayfinder',
      label: 'resume',
    });

    // Pins the spawn handoff: agent.start needs a pane_id, and the ONLY
    // source of it is tab.create's root_pane. Reading the wrong field here
    // breaks the ended-branch with no test failure elsewhere.
    expect(result).toEqual({ paneId: 'w9:p3', tabId: 'w9:t2' });
    expect(received[0].params.cwd).toBe('/home/john/dev/wayfinder');
    expect(received[0].params.focus).toBe(true);
  });

  it('starts an agent with resume args', async () => {
    const { socketPath, received } = fakeHerdr(() => ({
      id: '1',
      result: { type: 'agent_started', agent: {}, argv: ['claude', '--resume', 'abc'] },
    }));

    const result = await createHerdrClient(socketPath).startAgent({
      paneId: 'w9:p3',
      kind: 'claude',
      name: 'session-minder-resume',
      args: ['--resume', 'abc'],
    });

    expect(received[0].method).toBe('agent.start');
    expect(received[0].params).toMatchObject({
      pane_id: 'w9:p3',
      kind: 'claude',
      args: ['--resume', 'abc'],
    });
    expect(result.argv).toEqual(['claude', '--resume', 'abc']);
  });
});
