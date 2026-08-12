# session-minder Phase 2.b — Picker Design Spec

Date: 2026-08-10
Status: ratified in-session by John, section by section; pending his review of this
written document. Build happens in a separate session against the implementation
plan (not yet written).
Lineage: this is the phase the 2026-08-03 spec called "Phase 2.b — Dashboard."
The design conversation resolved it into something smaller and sharper than the
card-grid web UI sketched there; this document supersedes that section.

## The ruling that shaped everything

**Resume solely.** John's words. The tool exists for one act: getting back into a
past session. It is not a catalog, not a curation surface, not a browsing
experience. Every cut below follows from this.

Decisions made in the design conversation, each ratified explicitly:

| Question (from the opening prompt) | Ruling | Why |
|---|---|---|
| Browsing history or resuming work? | **Resuming, solely** | The stated pain is a resume problem; browsing was the catalog instinct |
| Where is John at the moment of use? | **In the terminal, inside Herdr** | The attach effect always materializes in Herdr; a browser round-trip serves nothing |
| On-demand or standing surface? | **On-demand picker** (`sm`) | Resuming is an intentional act; no daemon, no reserved pane, no stale state |
| Noise sessions (18 of 50)? | **Hidden; one flag reveals** (`sm --all`) | Escape hatch for misflagged sessions; doubles as the threshold-tuning window |
| Picker implementation? | **Plain CLI, zero new deps, pick step behind a seam** | fzf considered in depth and deferred — it is not installed, and the seam makes it a drop-in later without redesign |
| `title` / `note` columns? | **`title` read-only in play; `note` dormant; both columns untouched** | Row identity needs a name when one exists; a paragraph has no home in a one-line row |
| Auth beyond bearer token? | **No** | A terminal client on the tailnet uses `SESSION_MINDER_TOKEN` from the env; there is no new surface to protect |

> **Correction, 2026-08-11 (added after ratification; the text below is left as
> written).** The first bullet under "Fixed constraints" is false. On the same
> Herdr 0.7.5, two of four Hermes panes reported `agent_session`
> (`source: "herdr:hermes"`), and a live Hermes session was **focused** through
> the deployed service. The design anticipated this and needed no change — the
> join is generic, exactly as the parenthetical predicted. Treat every observed
> Herdr behavior as true-on-the-day-observed, not as a constant; this is the
> second such fact to expire with no version bump. See CLAUDE.md `<gotchas>`.

## Fixed constraints (inherited from 2.a, live-verified, not revisitable here)

- The attach contract returns `focused` / `spawned` / `degraded`; degraded is a
  200 with a manual recovery path, not an error.
- Hermes panes never report `agent_session` to Herdr — confirmed live twice,
  including on a session successfully resumed through our own endpoint. A Hermes
  session therefore can never be recognized as live and can never be focused;
  every Hermes attach takes the spawn branch. Claude and Kimi are unaffected.
  (If a future Herdr release starts reporting Hermes session ids, focus starts
  working with zero changes here — the join is generic.)
- `spawned` means the pane exists, not that the session is ready. A spawned agent
  can stall at an interactive gate (observed: Kimi's "Trust this folder?").
- Hermes prunes its own session history; some stored ids are no longer resumable
  and nothing in Postgres can know which.
- The 2.a suite's fake Herdr validates nothing real Herdr validates (name format,
  name uniqueness, blocking start). Green tests say nothing about the wire.

## Scope — three pieces of work, in dependency order

### 1. Split the Herdr error type (`src/herdr.ts`)

Two error classes where there is one today:

- **`HerdrRejectedError`** (new): Herdr *answered* with a protocol-level error.
  Carries Herdr's own `code` and `message` (`invalid_agent_name`,
  `agent_name_taken`, …) instead of discarding them.
- **`HerdrUnreachableError`** (kept, narrowed): Herdr could not answer — socket
  missing, connection refused, timeout, unparseable response, close without
  response.

The mapping rule lives in the one `request()` function: an error *response* →
Rejected; every failure to *get* a response → Unreachable. `DegradeReason` gains
`herdr_rejected`, whose degrade body carries `herdr_code` and `herdr_message`
through verbatim. The route's guard rule survives with two types: **only these
two Herdr error classes degrade; anything else is still a genuine 500.** The
degrade reason reflects whichever class occurred at whichever step failed.
Orphan-tab cleanup and socket discovery behave as today.

This lands first because every user-facing string below depends on it. The
single collapsed error type is what turned three one-line 2.a bugs into a day of
live bisection.

### 2. List endpoint — `GET /api/sessions`

The one new API surface. Bearer auth like everything else.

Query parameters, all optional:

- `q` — substring filter, case-insensitive, in SQL, over `title`,
  `project_path`, `platform`. (`sm jazz` passes this through.)
- `noise=true` — include noise-flagged rows. Default excludes them.
- `limit` — default 15, cap 100.

Row shape: `id`, `platform`, `title`, `project_path`, `host`, `started_at`,
`ended_at`, `message_count`, `live`. `live` is computed at request time by
joining rows against Herdr's live panes on `agent_session.value` — the same join
the attach route uses. Liveness is never stored.

Ordering: `started_at` descending, always. Live-first ordering was considered
and rejected — recency keeps row numbers stable across invocations ("row 1 is
what I was just doing"); the ● marker carries liveness without costing ordering
its predictability.

Rows with `status = 'pruned'` are excluded (nothing is pruned today; one WHERE
clause future-proofs the curation return). No host filtering — foreign rows
appear tagged and degrade honestly on attach.

If the Herdr pane join fails, the list must still return: rows carry
`live: null` and the response carries a top-level `herdr: "unreachable"` (or
`"rejected"`) so the picker can warn once and continue. Sessions live in
Postgres, not Herdr; the list never fails because liveness can't be computed.

### 3. The `sm` picker (`src/cli/`)

A client of the HTTP API and nothing else — no database access, no Herdr socket,
no imports from server internals. Same repo, same tsx runtime, reads
`SESSION_MINDER_TOKEN` and the service URL from the environment (`.env`
convention, like the hooks). A one-line alias or bin-stub makes it `sm`.
Because it speaks only HTTP, it works unchanged from any tailnet machine.

**Invocation:** `sm` (default list) · `sm <text>` (filter) · `sm --all`
(include noise).

**Display** (ratified mock):

```
sm — 14 resumable sessions (18 noise hidden — sm --all)

 #   tool     project               when        length    msgs
 1   claude   session-minder      ● 2h ago      3h 40m     182
 2   hermes   (telegram)            5h ago        22m       14
 3   claude   jazz-canon-site       yesterday   1h 05m      47
 4   kimi     wayfinder             Aug 8         38m       21
 5   claude   37pencils  [mbp]      Aug 7         55m       33

 ● = live in a Herdr pane now — picking it jumps there.
 Otherwise picking spawns a freshly resumed pane.
 [mbp] = lives on another machine — picking prints the command to run there.
```

- `#` — what you type to pick.
- `tool` — `platform`, shortened.
- `project` — identity column, fallback chain: `title` (when set) → tail of
  `project_path` → Hermes surface from `raw_metadata` (`(telegram)`, `(cli)`).
- `when` — `started_at`, relative, recency-ordered.
- `length` / `msgs` — duration and `message_count`: the substance signals that
  stand in for a title.
- `●` — live marker, Claude/Kimi only (constraint above). Means precisely:
  picking focuses instead of spawning.
- `[host]` — shown only when `host` differs from this machine.
- Deliberately absent: UUIDs, status/noise, pane ids, local hostnames.

**Interaction:** print rows, prompt for a number, `POST /attach`, render the
outcome, exit. The pick step ("rows in → chosen row out") sits behind a seam;
v1 is the numbered prompt. fzf, if it ever earns its way in, drops into the seam
as an alternate pick step. No TUI framework, no arrow keys, no persistent
process.

**Outcome rendering** — one message per outcome, no optimism:

| Outcome | Rendering |
|---|---|
| `focused` | "→ pane w9:p1" (focus switches instantly; the message is a formality) |
| `spawned` | "Opened a resumed pane (w9:pC)" + standing caveat: *if the pane is waiting at a prompt (e.g. a trust gate), answer it there* |
| `degraded` / `herdr_unreachable` | "Herdr can't be reached — paste this into any pane:" + command |
| `degraded` / `herdr_rejected` | Herdr's own message, shown, not paraphrased. Special mapping: `agent_name_taken` → "This session appears to be running in another pane already. Herdr can't jump to Hermes panes — switch to it by hand, or paste:" + command |
| `degraded` / `foreign_host` | "Captured on <host> — run it there:" + command |
| `degraded` / `no_project_path` | "No recorded project directory — run this from wherever it belongs:" + command |
| `degraded` / `not_resumable_platform` | Row can't be resumed; no command exists |

The `agent_name_taken` mapping is the honest answer to undetectable Hermes
liveness: we can never badge it in the list, but at the moment of attach the
name collision tells the truth for us.

**Exit codes:** 0 for focused, spawned, and degraded — degrade is a valid
answer, the 2.a rule carried to the shell. Nonzero only for real failures (API
unreachable, 401, 500).

## Declared unknowns (resolved by live verification, slots already designed)

1. **`interactive_ready` at a gate.** Herdr's `agent.start` response carries an
   `interactive_ready` field; 2.a never observed what it reports when an agent
   stalls at an interactive gate. One live spawn of Kimi against an untrusted
   directory answers it. If it can distinguish the stall, the spawned caveat
   becomes conditional; if not, the standing caveat stays. Design works either way.
2. **Spawning a Hermes-pruned id.** Does Herdr error (→ `herdr_rejected`,
   message shown) or does a pane open showing "Session not found"? One live
   spawn of a known-pruned id answers it. The rendering slot exists either way.

## Testing contract (binding on the implementation plan)

1. **The plan authors no test bodies.** Per test it states the rule pinned and
   the specific mutant that must die; the implementer writes the assertion and
   proves the mutant fails before the test counts.
2. The fake Herdr validates nothing real Herdr validates; the spec states
   plainly that the suite cannot verify anything crossing the socket.
3. **A live-verification ledger is part of 2.b's definition of done**, minimum
   entries: one attach per platform through the deployed service; the
   `interactive_ready` gate observation; the pruned-Hermes-id observation; one
   live `agent_name_taken` → `herdr_rejected` rendering.
4. **Standing completion gate (answers the 2.a retro's open question): any
   change crossing the Herdr boundary requires one live check against the
   running server before it is called done.**
5. Full mutation treatment for the honestly unit-testable core: the error
   mapping rule (a mutant collapsing Rejected into Unreachable must die), list
   endpoint filtering/defaults, and the picker's pure functions — row building,
   the title→basename→surface fallback chain, outcome rendering from response
   fixtures, relative time. The pick-step seam is what makes the picker core
   testable without a TTY.

## Out of scope (deliberate, not omissions)

- **Curation writes** — no surface sets `title`, `note`, or `status`. The
  columns stay, untouched. Single-user escape hatch: a manual `UPDATE` via psql
  works today and the picker will honor it.
- **Web UI, standing pane, TUI framework, fzf** — all cut or deferred; the seam
  keeps fzf reversible.
- **Honcho curation** — remains a deferred consumer of the table,
  sweep-shaped, per the recorded dependency. Nothing in 2.b blocks it; nothing
  in 2.b builds it.
- **Noise-threshold tuning** — cheap, separate, anytime; `sm --all` is the
  observation window for it.
- **Schema changes** — there are none.

## Follow-ups this design creates (outside the 2.b build)

- **Retarget `/index-session`** (existing skill, already under John's fingers)
  from the three `_system` markdown index files to writing `title` on the
  session's row in `_sessionminder.sessions`. John's gesture stays identical;
  the picker inherits the result. This retargeting is also the natural trigger
  for retiring the markdown index files — the status doc's remaining loose end.
- **Pre-first-use housekeeping (John's authority, will otherwise appear in the
  picker):** delete the synthetic verification row
  `phase2a-verify-20260809-133128`.

## Error handling summary

- Picker → API failures: honest message, nonzero exit. No retries.
- API → Herdr failures: the two-class split above; degrade responses carry the
  real cause; non-Herdr errors remain 500s.
- List endpoint: never fails for want of Herdr; `live: null` + top-level marker.

## Success test

John, in a Herdr pane, types `sm`, reads a 15-row list in one glance, types a
number, and is back inside the session he wanted — or holds a copyable command
and an honest sentence about why that was the best the system could do. Nothing
runs when he isn't asking. That's the whole tool.
