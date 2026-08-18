// test/harvest.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { main, type HarvestDeps } from '../src/cli/harvest.js';
import { ApiError } from '../src/cli/api.js';
import type { HermesTitle, Collected } from '../src/cli/hermes-state.js';

const title = (over: Partial<HermesTitle> = {}): HermesTitle => ({
  external_session_id: '20260812_201441_2b4480',
  title: 'Hermes Agent Claude Code vps8 Syncthing risks',
  message_count: 23,
  source: '/home/john/.hermes/state.db',
  ...over,
});

const collected = (over: Partial<Collected> = {}): Collected => ({
  titles: [title()],
  unreadable: [],
  collisions: [],
  ...over,
});

let out: string[];
let err: string[];
let putTitleMock: ReturnType<typeof vi.fn>;
let supportsMock: ReturnType<typeof vi.fn>;

const deps = (over: Partial<HarvestDeps> = {}): HarvestDeps => ({
  discover: () => ['/home/john/.hermes/state.db'],
  collect: () => collected(),
  putTitle: putTitleMock as unknown as HarvestDeps['putTitle'],
  supportsIfAbsent: supportsMock as unknown as HarvestDeps['supportsIfAbsent'],
  out: (l) => out.push(l),
  err: (l) => err.push(l),
  ...over,
});

beforeEach(() => {
  out = [];
  err = [];
  putTitleMock = vi.fn().mockResolvedValue({ id: 'row-uuid', title: 'x', applied: true });
  supportsMock = vi.fn().mockResolvedValue(true);
});

describe('harvest', () => {
  it('writes nothing at all without --apply', async () => {
    const code = await main([], deps());

    // The one test that matters most. Catches a harvester that treats the
    // bare invocation as consent — 48 rows written before John has read the
    // first line of output, against a preference he has stated repeatedly
    // (no bulk approvals, verify item by item).
    expect(putTitleMock).not.toHaveBeenCalled();
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/--apply/);
  });

  it('shows every title it would write, not just a count', async () => {
    const code = await main(
      [],
      deps({
        collect: () =>
          collected({
            titles: [
              title({ external_session_id: 'a', title: 'Fixing Vulcan Telegram Gateway Outage' }),
              title({ external_session_id: 'b', title: 'VPS8 Backup Plan Note' }),
            ],
          }),
      })
    );

    // Catches summarising as "would set 2 titles" and stopping. A dry run you
    // cannot read line by line is a bulk approval wearing a different hat.
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Fixing Vulcan Telegram Gateway Outage');
    expect(text).toContain('VPS8 Backup Plan Note');
  });

  it('sends if_absent on every write', async () => {
    await main(['--apply'], deps());

    // Catches omitting the guard. Nothing in the output would look wrong; the
    // damage is silent and lands on exactly the sessions John cared enough to
    // name by hand.
    expect(putTitleMock).toHaveBeenCalledTimes(1);
    expect(putTitleMock.mock.calls[0][0]).toMatchObject({
      platform: 'hermes',
      external_session_id: '20260812_201441_2b4480',
      if_absent: true,
    });
  });

  it('counts an already-named session as skipped rather than written', async () => {
    putTitleMock.mockResolvedValue({ id: 'row-uuid', title: 'John wrote this', applied: false });

    const code = await main(['--apply'], deps());

    // Catches trusting the 200 and reporting a write that the guard refused.
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/0 titled, 1 already named/);
  });

  it('treats a 404 as "not captured" and keeps going', async () => {
    putTitleMock
      .mockRejectedValueOnce(new ApiError(404, 'PUT /api/sessions/title → 404'))
      .mockResolvedValueOnce({ id: 'row-uuid', title: 'second', applied: true });

    const code = await main(
      ['--apply'],
      deps({
        collect: () =>
          collected({
            titles: [
              title({ external_session_id: 'a', title: 'Aaa uncaptured' }),
              title({ external_session_id: 'b', title: 'Bbb captured' }),
            ],
          }),
      })
    );

    // Two wrong implementations at once: letting the 404 abort the loop (Hermes
    // remembers 403 sessions, we captured 66 — most of them SHOULD 404), and
    // counting it as a failure, which would make a healthy run exit nonzero and
    // print dozens of scary lines.
    expect(code).toBe(0);
    expect(putTitleMock).toHaveBeenCalledTimes(2);
    expect(out.join('\n')).toMatch(/1 titled,.*1 not captured/s);
    expect(err.join('\n')).not.toMatch(/FAILED/);
  });

  it('reports a real failure, keeps going, and exits nonzero', async () => {
    putTitleMock
      .mockRejectedValueOnce(new ApiError(500, 'PUT /api/sessions/title → 500'))
      .mockResolvedValueOnce({ id: 'row-uuid', title: 'second', applied: true });

    const code = await main(
      ['--apply'],
      deps({
        collect: () =>
          collected({
            titles: [
              title({ external_session_id: 'a', title: 'Aaa broken' }),
              title({ external_session_id: 'b', title: 'Bbb fine' }),
            ],
          }),
      })
    );

    // Catches exiting 0 on a partial run. Also catches stopping at the first
    // error — one bad row should not cost the other 47.
    expect(code).toBe(1);
    expect(putTitleMock).toHaveBeenCalledTimes(2);
    expect(err.join('\n')).toMatch(/FAILED/);
  });

  it('skips a title longer than the route will accept, and says which', async () => {
    const long = 'x'.repeat(61);

    const code = await main(
      ['--apply'],
      deps({ collect: () => collected({ titles: [title({ title: long })] }) })
    );

    // Catches sending it anyway. The route 400s on >60, so this would surface
    // as a bare "service returned 400" with no hint that length was the reason.
    expect(putTitleMock).not.toHaveBeenCalled();
    // Reported as a counted reason, not silently dropped. (Counted rather than
    // listed since the filters landed — listing 118 cron rows is how a dry run
    // stops being read.)
    expect(out.join('\n')).toMatch(/1 over the 60-char limit/);
    expect(code).toBe(0);
  });

  it('surfaces an unreadable store instead of silently harvesting less', async () => {
    await main(
      [],
      deps({
        collect: () =>
          collected({ unreadable: [{ path: '/home/john/.hermes/profiles/x/state.db', error: 'boom' }] }),
      })
    );

    // Catches swallowing it. A profile that fails to open costs real titles,
    // and the run would otherwise look like a complete success.
    expect(err.join('\n')).toMatch(/profiles\/x\/state\.db/);
  });

  // Both of these rules exist because of what the first live run printed on
  // 2026-08-14. Nothing in the mocked suite predicted either one.
  it('skips Hermes cron runs', async () => {
    const code = await main(
      ['--apply'],
      deps({
        collect: () =>
          collected({
            titles: [
              title({
                external_session_id: 'cron_9c3376aac79a_20260804_060100',
                title: 'canon-drip · Aug 04 06:01',
              }),
              title({ external_session_id: '20260812_201441_2b4480', title: 'A real session' }),
            ],
          }),
      })
    );

    // Catches harvesting everything Hermes titled. 118 of the 408 titles on
    // disk are scheduled jobs — "Foundry Morning Digest · Aug 01 06:31" and
    // friends, one per day. They are machine output, they are what noise_flag
    // exists for, and they would bury the sessions John actually worked in.
    expect(code).toBe(0);
    expect(putTitleMock).toHaveBeenCalledTimes(1);
    expect(putTitleMock.mock.calls[0][0].title).toBe('A real session');
  });

  it('skips a title that is leaked model output rather than a name', async () => {
    const code = await main(
      ['--apply'],
      deps({
        collect: () =>
          collected({
            titles: [
              title({ external_session_id: 'a', title: '<think> The user is asking' }),
              title({ external_session_id: 'b', title: '## Enabling Browser Automation' }),
              title({ external_session_id: 'c', title: 'First line\nsecond line' }),
              title({ external_session_id: 'd', title: 'Convert CLAUDE.md to HTML Document' }),
            ],
          }),
      })
    );

    // Catches trusting Hermes' titler. Seen live: reasoning blocks and
    // markdown headings stored in the title column. The long ones happened to
    // trip the 60-char guard, which is luck — a short "<think> yes" would
    // sail through and land in the picker as if John had named it that.
    expect(code).toBe(0);
    expect(putTitleMock).toHaveBeenCalledTimes(1);
    expect(putTitleMock.mock.calls[0][0].title).toBe('Convert CLAUDE.md to HTML Document');
  });

  it('writes nothing when the running service lacks the if_absent guard', async () => {
    supportsMock.mockResolvedValue(false);

    const code = await main(['--apply'], deps());

    // The service runs from source under systemd with no watcher, so "checkout
    // has the guard, running process does not" is the normal state right after
    // an edit — confirmed live on 2026-08-14, where the running service
    // accepted an invalid if_absent and ignored it. An unguarded bulk write
    // reports success on every overwrite, so refusing is the only safe answer.
    expect(code).toBe(1);
    expect(putTitleMock).not.toHaveBeenCalled();
    expect(err.join('\n')).toMatch(/restart/i);
  });

  it('does not probe for the guard during a dry run', async () => {
    await main([], deps());

    // Catches making the dry run depend on the service being up. It reads
    // local SQLite and writes nothing; it should work with the service stopped.
    expect(supportsMock).not.toHaveBeenCalled();
  });

  it('refuses an unrecognised argument rather than ignoring it', async () => {
    const code = await main(['--dry-run'], deps());

    // Catches `argv.includes('--apply')` with no validation: someone reaching
    // for --dry-run or --force gets silently the opposite of what they typed.
    expect(code).toBe(1);
    expect(putTitleMock).not.toHaveBeenCalled();
  });
});
