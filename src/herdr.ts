// src/herdr.ts
// The only module that knows the Herdr wire protocol. Everything above this
// file speaks in HerdrPane objects, so dropping Herdr means replacing this
// file and the attach route's executor — not the DB contract (spec: Design
// guards, "keep the Herdr layer thin").
import net from 'node:net';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REQUEST_TIMEOUT_MS = 2000;

// `agent.start` doesn't return when the process launches — Herdr blocks the
// response until the agent is detected and ready for input. Measured live
// against Herdr 0.7.5: hermes took 3.1s end to end; claude and kimi came back
// under 2s, which is the only reason their spawns ever worked under the flat
// 2s default. 15s gives headroom for a slow boot without hanging the HTTP
// request as long as Herdr's own 30s ceiling would.
const AGENT_START_TIMEOUT_MS = 15000;

export interface HerdrAgentSession {
  source: string;
  agent: string;
  kind: string;
  value: string;
}

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  // The wire OMITS these keys entirely (not `null`) when Herdr has nothing to
  // report — confirmed against 0.7.5: a pane with no attached agent sends no
  // `agent`/`agent_session` key at all. Optional, not nullable.
  cwd?: string | null;
  agent?: string | null;
  agent_session?: HerdrAgentSession;
}

// One error type for every "Herdr can't answer" case — socket missing, server
// down, timeout, or a protocol-level error response. The attach route turns
// exactly this into a degrade response; anything else is a genuine 500.
export class HerdrUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HerdrUnreachableError';
  }
}

export interface HerdrClient {
  listPanes(): Promise<HerdrPane[]>;
  focusPane(paneId: string): Promise<void>;
  createTab(opts: {
    cwd: string;
    workspaceId?: string;
    label?: string;
  }): Promise<{ paneId: string; tabId: string }>;
  startAgent(opts: {
    paneId: string;
    kind: string;
    name: string;
    args: string[];
  }): Promise<{ argv: string[] }>;
}

function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    conn.setEncoding('utf8');
    let buf = '';
    let settled = false;

    const fail = (message: string) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(new HerdrUnreachableError(message));
    };

    const timer = setTimeout(() => fail(`${method} timed out`), timeoutMs);

    conn.on('error', (err) => {
      clearTimeout(timer);
      fail(`${method} failed: ${err.message}`);
    });

    conn.on('connect', () => {
      // `id` MUST be a string — Herdr rejects an integer outright.
      conn.write(JSON.stringify({ id: '1', method, params }) + '\n');
    });

    conn.on('data', (chunk) => {
      // `setEncoding('utf8')` above buffers any multi-byte sequence split
      // across a chunk boundary and hands us back a complete string here —
      // decoding each raw chunk independently (`chunk.toString()`) would
      // silently corrupt UTF-8 that straddles a read boundary.
      buf += String(chunk);
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      let parsed: any;
      try {
        parsed = JSON.parse(buf.slice(0, idx));
      } catch {
        return fail(`${method} returned unparseable JSON`);
      }
      if (parsed.error) {
        return fail(`${method} error: ${parsed.error.code} ${parsed.error.message}`);
      }
      if (settled) return;
      settled = true;
      // One request per connection and the full response is already in hand,
      // so destroying (rather than half-closing with `end()`) is safe here
      // and avoids leaving the client socket open if the peer never sends
      // its own FIN.
      conn.destroy();
      resolve(parsed.result ?? {});
    });

    conn.on('close', () => fail(`${method} closed without a response`));
  });
}

export function createHerdrClient(socketPath: string): HerdrClient {
  return {
    async listPanes() {
      const result = await request(socketPath, 'pane.list', {});
      return (result.panes ?? []) as HerdrPane[];
    },
    async focusPane(paneId) {
      await request(socketPath, 'pane.focus', { pane_id: paneId });
    },
    async createTab({ cwd, workspaceId, label }) {
      const result = await request(socketPath, 'tab.create', {
        cwd,
        focus: true,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        ...(label ? { label } : {}),
      });
      const paneId = result.root_pane?.pane_id;
      const tabId = result.tab?.tab_id;
      if (!paneId || !tabId) {
        throw new HerdrUnreachableError('tab.create returned no root pane');
      }
      return { paneId, tabId };
    },
    async startAgent({ paneId, kind, name, args }) {
      const result = await request(
        socketPath,
        'agent.start',
        {
          pane_id: paneId,
          kind,
          name,
          args,
          // Herdr's own readiness timeout must fire BEFORE our socket gives
          // up (AGENT_START_TIMEOUT_MS above) — that way a genuinely slow
          // agent produces a real Herdr error message instead of our opaque
          // "agent.start timed out".
          timeout_ms: 12000,
        },
        AGENT_START_TIMEOUT_MS
      );
      return { argv: (result.argv ?? []) as string[] };
    },
  };
}

// session-minder runs as a systemd service, NOT inside a Herdr pane, so it has
// no HERDR_SOCKET_PATH of its own. Discovery beats configuration here: John
// renames his Herdr session as his layout evolves (herdr-lab -> herdr-4up), and
// a pinned path in the unit file would rot silently on the next rename.
export async function discoverHerdrSocket(): Promise<string | null> {
  const override = process.env.SESSION_MINDER_HERDR_SOCKET;
  if (override) return override;

  const base = join(homedir(), '.config', 'herdr');
  const candidates = [join(base, 'herdr.sock')];

  try {
    const names = await readdir(join(base, 'sessions'));
    for (const name of names) {
      candidates.push(join(base, 'sessions', name, 'herdr.sock'));
    }
  } catch {
    // No named sessions directory — the default socket is the only candidate.
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      await request(candidate, 'ping', {});
      return candidate;
    } catch {
      // Stale socket file or a stopped server; try the next candidate.
    }
  }
  return null;
}
