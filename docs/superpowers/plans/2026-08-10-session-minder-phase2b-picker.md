# session-minder Phase 2.b — Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `sm` terminal picker and the two server pieces it needs — the Herdr error split and `GET /api/sessions` — per the ratified spec `docs/superpowers/specs/2026-08-10-session-minder-phase2b-picker-design.md`.

**Architecture:** Three layers, strictly ordered: `src/herdr.ts` gains a second error class (protocol rejection vs. unreachable); the attach route and a new list route consume the split; a new CLI under `src/cli/` is a pure HTTP client of the API — no DB access, no socket access, no server imports. The picker's logic lives in pure, mutation-testable modules; the only untestable parts (readline prompt, real wire) are isolated behind seams and covered by the live-verification ledger.

**Tech Stack:** Node 20 (global `fetch`, `node:readline/promises`), TypeScript ESM (imports use `.js` suffix), tsx runtime, Fastify 4, postgres.js, vitest. **No new dependencies.**

## Global Constraints

- **No new packages.** `package.json` dependencies/devDependencies change by zero entries.
- **No daemons, no persistent listeners, no polling.** `sm` runs, interacts once, exits.
- **Testing contract (binding, from the spec):** this plan authors **no test bodies**. Each test is specified as a **Rule** (the behavior pinned) plus a **Mutant that must die** (a specific wrong edit). The implementer writes the assertion, then **proves the kill**: apply the mutant, run the named test, see it fail *for that reason*, revert, confirm `git diff` on src/ is empty. A test whose mutant survives is not done.
- **Never weaken, rename, or delete an existing test or assertion.** The suite is currently 79 passing; it only grows.
- **Only `HerdrUnreachableError` and `HerdrRejectedError` may produce a degrade.** Any other error is a genuine 500. Degrades are HTTP 200.
- **The fake Herdr validates nothing real Herdr validates** (name format, name uniqueness, blocking start). A green suite says nothing about the wire — which is why Task 8's live ledger is part of the definition of done, and why any change crossing the Herdr boundary gets one live check against the running server before it's called done (standing gate, per spec).
- **Wire facts come from source, not from this plan.** The Herdr protocol lives in `src/herdr.ts`; if anything here seems to disagree with it, the source wins and the discrepancy gets reported. For new Herdr facts, read `herdr api schema --json`, not the docs (they disagree — see CLAUDE.md gotchas).
- **sudo is John's, always** (service restart in Task 8). Read-only psql queries are fine.
- **Commit per task, direct to `main`** (established project practice, John's 2.a consent carried forward).
- Run tests with `npx vitest run <file>` (or `npm test` for the full suite); typecheck with `npm run typecheck`. Both must be clean at every commit.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/herdr.ts` | modify | Add `HerdrRejectedError`; `request()` maps protocol-error responses to it |
| `src/attach.ts` | modify | `DegradeReason` union gains `'herdr_rejected'` (type only; `resolveAttach` never returns it) |
| `src/routes/attach.ts` | modify | Catch sites distinguish the two classes; rejected degrades carry `herdr_code`/`herdr_message` |
| `src/host.ts` | create | `localHost()` extracted from `routes/attach.ts` so the list route reuses it |
| `src/routes/sessions.ts` | create | `GET /api/sessions` — SQL, filters, liveness join, `noise_hidden` count |
| `src/server.ts` | modify | Register the sessions route |
| `src/cli/args.ts` | create | Pure argv parsing (`--all`, free-text filter) |
| `src/cli/api.ts` | create | HTTP client + config resolution (env → repo `.env.local`) |
| `src/cli/rows.ts` | create | Pure display core: identity chain, relative time, duration, alignment, markers |
| `src/cli/outcome.ts` | create | Pure outcome rendering: per-reason messages, exit codes |
| `src/cli/pick.ts` | create | The pick seam: numbered readline prompt behind `pick(rowCount)` |
| `src/cli/sm.ts` | create | Thin main: wire args → api → rows → pick → attach → outcome |
| `.env.example` | modify | Add `SESSION_MINDER_URL` |
| `test/herdr.test.ts` | extend | Error-mapping rules |
| `test/attach-route.test.ts` | extend | Split-consumption rules |
| `test/sessions-route.test.ts` | create | List route rules (harness copied from `attach-route.test.ts`'s `vi.hoisted` pattern) |
| `test/cli-args.test.ts`, `test/cli-api.test.ts`, `test/cli-rows.test.ts`, `test/cli-outcome.test.ts`, `test/cli-main.test.ts` | create | CLI rules |

---

### Task 1: Herdr error split (`src/herdr.ts`)

**Files:**
- Modify: `src/herdr.ts`
- Test: `test/herdr.test.ts` (extend — existing tests untouched)

**Interfaces:**
- Produces: `export class HerdrRejectedError extends Error { name = 'HerdrRejectedError'; constructor(public code: string, message: string, public method: string) }` — a **sibling** of `HerdrUnreachableError`, deliberately not a subclass: every catch site must decide about both, and `instanceof HerdrUnreachableError` must be false for a rejection (that silent-swallow is exactly the 2.a failure mode).
- The mapping rule, all inside `request()`: `parsed.error` present in a response → reject with `HerdrRejectedError(parsed.error.code, parsed.error.message, method)`. Every failure to *get* a response — connection error, timeout, unparseable JSON, close-without-response — remains `HerdrUnreachableError`. No other behavior of `request()` changes.
- Note: `discoverHerdrSocket()`'s probe loop catches *all* errors per candidate (try next) — unchanged, and now also correct for a rejecting socket.

- [ ] **Step 1: Write the failing tests** (implementer authors bodies against these contracts; the existing fake-socket harness in `test/herdr.test.ts` already supports scripted error responses)

  1. **Rule:** a response containing `{"error":{"code":"invalid_agent_name","message":"..."}}` rejects with `HerdrRejectedError` whose `code` and `message` are Herdr's own, verbatim.
     **Mutant that must die:** in `request()`, revert the error-response branch to `fail(...)` / `HerdrUnreachableError` — the exact 2.a collapse.
  2. **Rule:** `HerdrRejectedError` is not an `instanceof HerdrUnreachableError` (and vice versa).
     **Mutant that must die:** declare `class HerdrRejectedError extends HerdrUnreachableError`.
  3. **Rule:** connection-refused, timeout, and close-without-response still reject with `HerdrUnreachableError` (the existing tests pin most of this; add whichever of the three has no coverage after the change).
     **Mutant that must die:** map all failures in `fail()` to `HerdrRejectedError`.

- [ ] **Step 2: Run to verify the new tests fail** — `npx vitest run test/herdr.test.ts`. Expected: new tests fail (`HerdrRejectedError` not exported); all pre-existing tests still pass.
- [ ] **Step 3: Implement** the class and the mapping in `request()`'s data handler (the `parsed.error` branch is at the current `fail(\`${method} error: ...\`)` site).
- [ ] **Step 4: Full suite + typecheck** — `npm test && npm run typecheck`. Expected: all green, zero existing-test changes.
- [ ] **Step 5: Prove the kills** — apply mutants 1–3 one at a time; confirm the named test (and only sensible others) fails; revert each; `git diff -- src/` empty.
- [ ] **Step 6: Commit** — `git add src/herdr.ts test/herdr.test.ts && git commit -m "feat(herdr): split protocol rejections into HerdrRejectedError"`

---

### Task 2: Attach route consumes the split

**Files:**
- Modify: `src/attach.ts` (type union only), `src/routes/attach.ts`
- Test: `test/attach-route.test.ts` (extend)

**Interfaces:**
- Consumes: `HerdrRejectedError` from Task 1.
- Produces: degrade bodies of a new shape when the cause was a rejection:
  `{ action: 'degraded', reason: 'herdr_rejected', command: string | null, herdr_code: string, herdr_message: string }`.
  All existing degrade shapes unchanged. `DegradeReason` in `src/attach.ts` becomes
  `'herdr_unreachable' | 'herdr_rejected' | 'foreign_host' | 'not_resumable_platform' | 'no_project_path'`
  with a comment stating `resolveAttach` never returns `'herdr_rejected'` — only the route's catch sites produce it.
- Route logic: all three catch points (listPanes, focusPane, createTab/startAgent) change their guard from `if (!(err instanceof HerdrUnreachableError)) throw err;` to rethrow anything that is **neither** class. A small helper builds the degrade body: start from `degradeFallback(session)` (unchanged); if the caught error is a `HerdrRejectedError`, override `reason` to `'herdr_rejected'` and attach `herdr_code`/`herdr_message` from it. For the listPanes site, record the caught error in a local before setting `panes = null`, so the final degrade reflects the true class. Orphan-tab cleanup fires for both classes exactly as it fires today (a rejection after `tab.create` is precisely the orphan case — `agent_name_taken` proved it live).

- [ ] **Step 1: Write the failing tests**

  1. **Rule:** spawn path, `startAgent` rejects with `HerdrRejectedError('agent_name_taken', ...)` → HTTP 200, `action:'degraded'`, `reason:'herdr_rejected'`, `herdr_code:'agent_name_taken'`, `herdr_message` verbatim, `command` present, **and** `closeTab` was called with the created tab id.
     **Mutant that must die:** in the spawn catch, build the body from `degradeFallback` alone (today's behavior — reason stays `herdr_unreachable`, no code/message).
  2. **Rule:** focus path, `focusPane` rejects with `HerdrRejectedError` → same rejected shape (no tab cleanup — none was created).
     **Mutant that must die:** focus catch guard narrowed back to `HerdrUnreachableError` only (a rejection becomes a 500).
  3. **Rule:** `HerdrUnreachableError` failures still degrade with `reason:'herdr_unreachable'` and **no** `herdr_code`/`herdr_message` keys.
     **Mutant that must die:** helper always sets `reason:'herdr_rejected'`.
  4. **Rule:** a non-Herdr error (e.g. `TypeError`) from `startAgent` still produces a 500 — the guard rethrows.
     **Mutant that must die:** delete the rethrow guard at the spawn catch (2.a's surviving-mutant-6 pattern; both new tests 1 and 4 must together cover both classes plus the rethrow).
  5. **Rule:** `listPanes` rejecting with `HerdrRejectedError` → degrade `reason:'herdr_rejected'` with code/message (the step-tracking rule: the reason reflects the class *at the step that failed*).
     **Mutant that must die:** discard the caught listPanes error and let `resolveAttach(panes:null)`'s `herdr_unreachable` stand.

- [ ] **Step 2: Run to verify failures** — `npx vitest run test/attach-route.test.ts`.
- [ ] **Step 3: Implement** (`src/attach.ts` union first — `npm run typecheck` will drive the route edits).
- [ ] **Step 4: Full suite + typecheck.** Existing route tests must pass unmodified — the old unreachable-path shapes are unchanged.
- [ ] **Step 5: Prove the kills** (mutants 1–5, one at a time, revert, clean diff).
- [ ] **Step 6: Commit** — `git commit -m "feat(attach): degrade with herdr_rejected carrying Herdr's own code and message"`

---

### Task 3: `GET /api/sessions` (`src/routes/sessions.ts`, `src/host.ts`)

**Files:**
- Create: `src/routes/sessions.ts`, `src/host.ts`
- Modify: `src/server.ts` (register route), `src/routes/attach.ts` (import `localHost` from `../host.js`, delete the local copy)
- Test: `test/sessions-route.test.ts` (create; copy the `vi.hoisted` mock harness shape from `test/attach-route.test.ts` — mockSql, mockClient, mockDiscover)

**Interfaces:**
- Produces (response contract the CLI consumes — this is a NEW contract, defined here):
  ```
  200 {
    sessions: Array<{
      id: string; platform: 'claude_code'|'hermes'|'kimi_code';
      title: string | null; project_path: string | null;
      host: string; foreign: boolean;
      started_at: string; ended_at: string | null;
      message_count: number | null;
      hermes_surface: string | null;   // from raw_metadata, hermes rows only
      live: boolean | null;            // null when Herdr couldn't answer
    }>;
    noise_hidden: number;              // rows excluded by the default noise filter
    herdr: 'ok' | 'unreachable' | 'rejected';
  }
  ```
- Query params: `q` (substring, case-insensitive, over `title`, `project_path`, `platform`), `noise=true` (include noise rows; `noise_hidden` is then 0), `limit` (default 15, clamp 1–100, non-numeric → default).
- `src/host.ts`: move `localHost()` verbatim from `routes/attach.ts` **including its `||`-not-`??` comment** (the empty-env gotcha it records is real). Export it; both routes import it.
- Liveness: `discoverHerdrSocket()` + `listPanes()` (same pattern as the attach route); build a `Set` of `agent_session.value`s; `live = set.has(external_session_id)`. Select `external_session_id` for the join; do **not** include it in the response. Any Herdr failure (either error class, or no socket) → every `live: null`, `herdr` set to `'unreachable'` or `'rejected'` accordingly, rows still returned — the list never fails for want of Herdr.
- SQL (one query for rows + one count for `noise_hidden`): `WHERE status <> 'pruned'`, `AND noise_flag = false` unless `noise=true`, optional `AND (title ILIKE ${'%'+q+'%'} OR project_path ILIKE ... OR platform ILIKE ...)`, `ORDER BY started_at DESC`, `LIMIT` clamped. Use postgres.js interpolation exactly as `routes/capture.ts` does — never string concatenation into SQL.

- [ ] **Step 1 (live fact, read-only, before any code): verify the Hermes surface path.** The 2026-08-03 spec *says* the capture adapter stores the surface at `raw_metadata.hermes.surface` — verify against reality, not docs: `psql "$DATABASE_URL" -c "SELECT raw_metadata FROM _sessionminder.sessions WHERE platform='hermes' AND raw_metadata::text <> '{}' LIMIT 5;"` (or read `src/routes/capture.ts` + the hermes hook script). Record the actual JSON path in the task report; implement `hermes_surface` extraction against what you observed. If no hermes row carries a surface at all, `hermes_surface` is honestly null everywhere — implement the extraction against the documented path, note it as unobserved, and flag it for the Task 8 ledger.

- [ ] **Step 2: Write the failing tests**

  1. **Rule:** no/bad bearer token → 401. **Mutant:** drop the `requireAuth` preHandler.
  2. **Rule:** default query excludes `noise_flag = true` rows and `status = 'pruned'` rows, orders `started_at DESC`, limits 15 — pinned by asserting what was passed to the sql mock (clauses/parameters), since mockSql executes nothing.
     **Mutants (one per clause, each individually):** drop the noise filter; drop the pruned filter; `ASC`; no limit.
  3. **Rule:** `?q=jazz` adds the three-column ILIKE; parameterized, not concatenated.
     **Mutant:** filter `project_path` only.
  4. **Rule:** `?noise=true` removes the noise filter and reports `noise_hidden: 0`.
     **Mutant:** ignore the param.
  5. **Rule:** `limit` clamps — `?limit=500` → 100, `?limit=abc` → 15.
     **Mutant:** pass the raw value through.
  6. **Rule:** a pane whose `agent_session.value` equals a row's `external_session_id` → that row `live: true`; rows with no matching pane → `live: false`. The join key is `agent_session.value` and nothing else.
     **Mutant that must die:** compute `live` from `ended_at === null` — the tempting wrong definition 2.a explicitly rejected ("live is a pane match, not ended_at").
  7. **Rule:** `discoverHerdrSocket` → null ⇒ every `live: null`, `herdr:'unreachable'`, sessions still present. `listPanes` throwing `HerdrRejectedError` ⇒ `herdr:'rejected'`, same nulls.
     **Mutant:** let the route 500 when Herdr is down.
  8. **Rule:** `foreign` is `session.host !== localHost()`, and `localHost()` honors `SESSION_MINDER_HOST_NAME` before `os.hostname()`.
     **Mutant that must die:** compare against `hostname()` directly (env ignored) — the regression that would re-create 2.a's every-attach-degrades precondition, now in display form.
  9. **Rule (attach regression):** the attach route still passes its full suite after `localHost` moves to `src/host.ts` — no new test, but `npm test` green is the gate for the extraction.

- [ ] **Step 3: Run to verify failures.**
- [ ] **Step 4: Implement** route + host extraction + registration (`registerSessionsRoute(app)` after the other two in `src/server.ts`).
- [ ] **Step 5: Full suite + typecheck.**
- [ ] **Step 6: Prove the kills** (mutants 1–8; the ended_at and hostname mutants are the two that guard against repeating 2.a history — do not skip their red runs).
- [ ] **Step 7: Commit** — `git commit -m "feat(api): GET /api/sessions with liveness annotation and noise accounting"`

---

### Task 4: CLI arguments and API client (`src/cli/args.ts`, `src/cli/api.ts`)

**Files:**
- Create: `src/cli/args.ts`, `src/cli/api.ts`
- Modify: `.env.example` (add `SESSION_MINDER_URL=` with a comment: base URL of the running service, e.g. `http://100.118.195.63:PORT` — the CLI reads it from the environment or from this repo's `.env.local`)
- Test: `test/cli-args.test.ts`, `test/cli-api.test.ts`

**Interfaces:**
- `args.ts` produces: `parseArgs(argv: string[]): { q: string | undefined; all: boolean }` — `--all` anywhere sets `all`; every other token joins (space-separated) into `q`; no tokens → `q` undefined.
- `api.ts` produces:
  - `resolveConfig(): { baseUrl: string; token: string }` — precedence: `process.env.SESSION_MINDER_URL` / `SESSION_MINDER_TOKEN`, then the same keys parsed from the repo's `.env.local` located **relative to the module** (`new URL('../../.env.local', import.meta.url)`), never relative to cwd — `sm` must work from any directory. Missing after both sources → throw an error naming the exact variables.
  - `listSessions(opts: { q?: string; all?: boolean }): Promise<ListResponse>` — GET `${baseUrl}/api/sessions` with `q` URL-encoded, `noise=true` when `all`, `Authorization: Bearer ${token}`.
  - `attachSession(id: string): Promise<AttachResponse>` — POST `${baseUrl}/api/sessions/${id}/attach`, same header.
  - Both: non-2xx → throw `ApiError` carrying `status` (401 vs 500 vs network-refused must be distinguishable by the caller). `ListResponse` mirrors Task 3's contract; `AttachResponse` is a union of the attach route's three action shapes (transcribe the field names from `src/routes/attach.ts` — the source of truth — into a type here).
- `.env.local` parser: ~10 lines — split lines, skip `#` and blanks, `KEY=value` split on first `=`, no quoting support needed. Zero dependencies.

- [ ] **Step 1: Write the failing tests**

  1. **Rule (args):** `['jazz','canon']` → `q:'jazz canon'`; `['--all']` → all true, q undefined; `['--all','jazz']` and `['jazz','--all']` → both set.
     **Mutants:** `--all` treated as filter text; only first token kept.
  2. **Rule (api, with `vi.stubGlobal('fetch', ...)`):** every request carries `Authorization: Bearer <resolved token>`.
     **Mutant:** drop the header.
  3. **Rule:** `q` is URL-encoded (`'jazz canon'` → `q=jazz%20canon` or `+`); `all` → `noise=true` present; neither → bare `/api/sessions`.
     **Mutant:** interpolate `q` raw into the URL.
  4. **Rule:** non-2xx response → `ApiError` with the status; the body is not silently parsed as success.
     **Mutant:** return `res.json()` unconditionally.
  5. **Rule:** config precedence env-over-file, and file path is module-relative.
     **Mutant that must die:** resolve `.env.local` against `process.cwd()` — kills the works-only-from-repo-dir regression.

- [ ] **Step 2: Run to verify failures.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Full suite + typecheck.** — [ ] **Step 5: Prove the kills.**
- [ ] **Step 6: Commit** — `git commit -m "feat(cli): argument parsing and API client with env-then-envfile config"`

---

### Task 5: Row display core (`src/cli/rows.ts`)

**Files:**
- Create: `src/cli/rows.ts`
- Test: `test/cli-rows.test.ts`

**Interfaces:**
- Consumes: `ListResponse['sessions'][number]` from Task 4.
- Produces (all pure, all taking `now: Date` as a parameter — nothing reads the clock internally):
  - `identity(s): string` — the ratified fallback chain: `title` → last path segment of `project_path` → `(${hermes_surface})` → literal `(no project)`. Full UUIDs never appear anywhere in output (spec rule).
  - `relTime(now, startedAt): string` — `<60m`: `"37m ago"`; `<24h`: `"5h ago"`; yesterday (calendar): `"yesterday"`; else `"Aug 8"` (month + day).
  - `duration(startedAt, endedAt): string` — `"3h 40m"` / `"22m"`; `ended_at` null → `"—"`.
  - `formatList(response: ListResponse, now: Date): string[]` — header line (`N resumable sessions (M noise hidden — sm --all)`, the `--all` hint and count only when `noise_hidden > 0`), aligned columns `# tool project when length msgs`, `●` prefix on `when` **only** when `live === true`, ` [host]` suffix on identity only when `foreign`, legend lines, and — when `herdr !== 'ok'` — the warning line `"Herdr unreachable — live markers unavailable; attach will hand you commands."` Platform display names: `claude_code→claude`, `hermes→hermes`, `kimi_code→kimi`.

- [ ] **Step 1: Write the failing tests**

  1. **Rule:** identity chain order — a row with all of title/path/surface set shows the title; null title shows the basename; null both (hermes) shows the surface; all null shows `(no project)`.
     **Mutant that must die:** reorder the chain (basename before title).
  2. **Rule:** the boundaries of `relTime` — 59m vs 61m, 23h vs yesterday, yesterday vs dated.
     **Mutant:** `<24h` branch dropped (everything over an hour goes to dates).
  3. **Rule:** `duration` handles null `ended_at` as `"—"`.
     **Mutant:** render `NaN`/throw on null.
  4. **Rule:** `●` appears iff `live === true` — explicitly not for `live: null`.
     **Mutant that must die:** truthiness check that marks `null` rows (`live != false`), which would paint every row live whenever Herdr is down.
  5. **Rule:** `[host]` tag iff `foreign`, showing the row's own host.
     **Mutant:** tag every row.
  6. **Rule:** the herdr warning line appears iff `herdr !== 'ok'`.
     **Mutant:** warning unconditional.
  7. **Rule:** noise accounting — header shows the hidden count and `--all` hint only when `noise_hidden > 0`.
     **Mutant:** always show it (`0 noise hidden` clutter).

- [ ] **Step 2–5:** fail → implement → suite+typecheck → prove the kills.
- [ ] **Step 6: Commit** — `git commit -m "feat(cli): pure row-display core with identity fallback chain"`

---

### Task 6: Outcome rendering (`src/cli/outcome.ts`)

**Files:**
- Create: `src/cli/outcome.ts`
- Test: `test/cli-outcome.test.ts`

**Interfaces:**
- Consumes: `AttachResponse` from Task 4.
- Produces: `renderOutcome(r: AttachResponse): { lines: string[]; exitCode: 0 }` — always exit 0; server outcomes are all valid answers (the 2.a rule at the shell). Messages, per the spec's ratified table:
  - `focused` → `→ pane ${pane_id}`
  - `spawned` → `Opened a resumed pane (${pane_id}).` plus the standing caveat line: `If the pane is waiting at a prompt (e.g. a trust gate), answer it there.`
  - `degraded`, by `reason`:
    - `herdr_unreachable` → `Herdr can't be reached — paste this into any pane:` + command
    - `herdr_rejected` with `herdr_code === 'agent_name_taken'` → `This session appears to be running in another pane already. Herdr can't jump to Hermes panes — switch to it by hand, or paste:` + command
    - `herdr_rejected` otherwise → `Herdr refused: ${herdr_message}` + command (when present)
    - `foreign_host` → `Captured on ${host} — run it there:` + command *(requires the session's host — signature may take the picked session row alongside the response; implementer's call, noted in the task report)*
    - `no_project_path` → `No recorded project directory — run this from wherever it belongs:` + command
    - `not_resumable_platform` → `This session can't be resumed (unknown platform).` — no command exists
  - Every command prints **alone on its own line** (copyable), never embedded mid-sentence.

- [ ] **Step 1: Write the failing tests**

  1. **Rule:** each of the seven cases above renders its message; commands are on a dedicated line.
     **Mutants (pick the three sharpest, prove each):** (a) `agent_name_taken` matched on `herdr_message` text instead of `herdr_code` — must die (messages are Herdr's to change; the code is the contract); (b) generic `herdr_rejected` message swallows `herdr_message` — must die (showing Herdr's words verbatim is the whole point of the split); (c) command interpolated into the sentence line — must die.
  2. **Rule:** `renderOutcome` returns exit code 0 for `degraded`.
     **Mutant that must die:** degrade → exit 1 (degrade-is-not-an-error, made structural).

- [ ] **Step 2–5:** fail → implement → suite+typecheck → prove the kills.
- [ ] **Step 6: Commit** — `git commit -m "feat(cli): honest per-reason outcome rendering"`

---

### Task 7: Pick seam and main (`src/cli/pick.ts`, `src/cli/sm.ts`)

**Files:**
- Create: `src/cli/pick.ts`, `src/cli/sm.ts`
- Test: `test/cli-main.test.ts`

**Interfaces:**
- `pick.ts` produces: `pick(rowCount: number): Promise<number | null>` — prompts `Pick # (enter to cancel): ` via `node:readline/promises` on stdin/stdout; returns the **1-based** number typed, or `null` for empty input, `q`, EOF (Ctrl-D), or any input that isn't an integer in `[1, rowCount]` (invalid → re-prompt up to twice, then null). **This is the fzf seam**: any future alternate picker implements this exact signature; nothing else in the CLI changes.
- `sm.ts` produces: `main(argv: string[], deps = { listSessions, attachSession, pick, out: console.log, err: console.error }): Promise<number>` — dependency-injected so `test/cli-main.test.ts` runs it without a TTY or network; plus a last-line entry guard that runs `main(process.argv.slice(2))` and `process.exit(await ...)` only when executed directly (`import.meta.url` vs `process.argv[1]` comparison, the standard ESM pattern).
  Flow: parse args → `listSessions` → empty list → print `No matching sessions.`, exit 0 → `formatList` → `pick(sessions.length)` → null → exit 0, no attach → else `attachSession(sessions[n - 1].id)` → `renderOutcome` → its exit code. `ApiError`/network errors → one honest line on stderr, exit 1.
- John's alias (deliverable text, his `.bashrc`, his hands): `alias sm='npx tsx /home/john/dev/active/session-minder/src/cli/sm.ts'`

- [ ] **Step 1: Write the failing tests** (stub all deps; `pick` is a stub here — the real readline path is Task 8's live smoke)

  1. **Rule:** picking `3` attaches `sessions[2].id` — the display is 1-based, the array 0-based.
     **Mutant that must die:** `sessions[n]` — the off-by-one that resumes the wrong session, this project's local version of focusing a stranger's pane.
  2. **Rule:** cancel (`pick` → null) → exit 0 and `attachSession` never called.
     **Mutant:** attach row 1 on cancel.
  3. **Rule:** empty session list → friendly line, exit 0, no pick, no attach.
     **Mutant:** call `pick(0)` anyway.
  4. **Rule:** `listSessions` throwing `ApiError(401)` → stderr line mentioning the token, exit 1; network-refused → stderr line mentioning the service, exit 1.
     **Mutant:** swallow the error and exit 0.
  5. **Rule:** `--all` and free-text args flow through to `listSessions` as `{ all: true }` / `{ q }`.
     **Mutant:** args parsed but discarded.

- [ ] **Step 2–5:** fail → implement → suite+typecheck → prove the kills.
- [ ] **Step 6: Commit** — `git commit -m "feat(cli): sm entry point with injectable pick seam"`

---

### Task 8: Deploy + live-verification ledger (definition of done)

**Files:**
- Modify: `.docs/status.md` (rewrite "Where are we" / "What's next" from this task's findings, in the file's plain-English voice)
- The ledger lives in this build session's SDD progress file, same as 2.a.

Standing gates for this task, carried from 2.a: **one retry max on a failed spawn; no code change from a live finding without showing John the diagnosis first; close every tab you create and verify the pane baseline after; sudo is John's.**

- [ ] **Step 1 (John, sudo): restart the service** so it runs this branch's code — `sudo systemctl restart session-minder`. Verify: `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://$HOST:$PORT/api/sessions` returns 200 (was 404 before the deploy — that flip is the new-code-live check).
- [ ] **Step 2: List-endpoint live smoke.** `curl` the endpoint; verify against psql ground truth: row count ≤ 15, no `noise_flag=true` rows, ordering by `started_at DESC`, `noise_hidden` equals the psql count, `?q=` and `?noise=true` behave. This is the only real test the SQL ever gets (the suite's sql is a mock) — record actual numbers in the ledger.
- [ ] **Step 3: `sm` end-to-end, one attach per platform** through the real picker in a real pane: a Claude row (live one → expect `focused`; ended → `spawned`), a Kimi row, a Hermes row (resumable id — 2.a found 9 of 15 stored Hermes ids still valid; pick from `hermes sessions list` overlap). Confirm pane content, not just the response. Record each.
- [ ] **Step 4: Declared unknown #1 — `interactive_ready` at a gate.** Spawn Kimi against a directory it has never trusted; observe what `agent.start` returns (`interactive_ready` value, or timeout, or error) while the pane sits at "Trust this folder?". Record verbatim. **Show John the finding.** If it cleanly distinguishes the stall, file the conditional-caveat improvement as a follow-up — do not implement it in this task.
- [ ] **Step 5: Declared unknown #2 — pruned Hermes id.** `sm` a Hermes row whose id is absent from `hermes sessions list`; observe: Herdr error (→ which `herdr_code`?) or a pane showing "Session not found"? Record verbatim; show John; follow-up if the rendering wants tuning.
- [ ] **Step 6: The `agent_name_taken` honesty path, live.** With a live Hermes session running (spawned in Step 3), `sm` the same session again; confirm the picker renders the "appears to be running in another pane already" message with the copyable command, and that no orphan tab survives (`herdr` tab list back to baseline).
- [ ] **Step 7: Housekeeping reminders to John (his authority, not yours):** delete the synthetic row `phase2a-verify-20260809-133128` (it will otherwise appear in `sm`); add the `sm` alias to `.bashrc`; the still-open 2.a items (token rotation, idea-foundry-ops rule commit).
- [ ] **Step 8: Rewrite `.docs/status.md`**, commit — `git commit -m "docs: Phase 2.b live-verified; status reflects the picker"`.

---

## Self-Review (performed at plan-writing time)

- **Spec coverage:** error split → Task 1–2; list endpoint incl. `noise_hidden`, `foreign`, `herdr` marker → Task 3; picker display/fallback chain/markers → Task 5; outcome table incl. `agent_name_taken` → Task 6; seam + exit codes → Tasks 6–7; the two declared unknowns → Task 8 Steps 4–5; the standing live gate → Global Constraints + Task 8; `/index-session` retarget and Honcho sweep are spec follow-ups, deliberately absent here.
- **Additions beyond the spec's letter, flagged:** `foreign`/`hermes_surface`/`noise_hidden` response fields (the spec's display rules require them; defining them server-side keeps the CLI dumb) and the config-resolution order for the CLI (spec said "env convention"; the module-relative `.env.local` fallback makes `sm` work from any directory).
- **Type consistency:** `ListResponse`/`AttachResponse` defined once in Task 4 and consumed by name in 5–7; `pick` signature identical in Tasks 7's two mentions; `localHost` import path `../host.js` consistent in Task 3.
- **Placeholder scan:** no TBDs; every test names its mutant; the one deliberate openness (outcome.ts signature for `foreign_host`'s host value) is an implementer's call explicitly marked as such.
