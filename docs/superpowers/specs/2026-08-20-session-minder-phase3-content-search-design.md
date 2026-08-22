# session-minder Phase 3 — Content Search ("find") Design Spec

Date: 2026-08-20
Status: RATIFIED 2026-08-20 by John, in-session, all six ruling slots (R1-R6)
as recommended. Build happens in a separate session against the implementation
plan (not yet written).
Lineage: Phase 1 (2026-08-03 spec) built capture; 2.a the Herdr layer; 2.b the
picker. The 2026-08-03 spec named no Phase 3 — this document creates it. The
trigger was a live failure on 2026-08-20: asked to find "recent sessions
dealing with vps2," session-minder answered zero hits while the vps2
retirement session from that same morning sat in its own table. The search
route matches `title`, `project_path`, `platform` only (src/routes/sessions.ts)
— no session carried "vps2" in any of the three. Hermes' built-in
session_search (FTS5 over message content) found it immediately. The gap is
real, observed, and in the tool's core purpose: you cannot resume the session
you cannot find.

## The shaping question

The 2.b ruling was "resume solely." Content search does not reopen that — it
serves it. The resume act has two halves: *get back into* a session (2.b) and
*know which one* (this phase). Today's picker answers "what was I just doing"
(recency list) and "the session I named" (title filter). It cannot answer "the
session where we did X" — which is how John actually remembers sessions. His
words from the 2026-08-20 session: "This sort of search is one that I'd like
to systematize."

## Ruling slots (each with recommendation)

### R1 — What gets indexed

**Recommendation: user and assistant message text only. Tool output, thinking
blocks, and system/session_meta rows are excluded.**

Observed basis (measured 2026-08-20 against the live stores):

| Store | user | assistant | tool | indexed share |
|---|---|---|---|---|
| Hermes, all 10 state.dbs | 4.2 MB | 4.9 MB | 75.4 MB | ~11% |
| Claude Code jsonl (2 largest sampled) | — | — | — | 0.2–0.4% of file bytes |

Full-content ingest would buy 10–100x the storage for tool noise nobody
searches. The 2026-08-20 miss that triggered this phase would have been fixed
by user+assistant alone: "vps2" appears in John's opening message of the
retirement session.

- *Rejected: index everything.* 75 MB of Hermes tool output plus Claude's
  tool-result-dominated jsonl is the bulk without the recall.
- *Rejected: user messages only.* Assistant messages are where conclusions
  land ("vps2 is closed everywhere"). At 4.9 MB across all of Hermes history,
  they cost nothing.

### R2 — Where the index lives

**Recommendation: a new `_sessionminder.messages` table, one row per message,
with a generated `tsvector` column and a GIN index. `ON DELETE CASCADE` from
`sessions.id` so pruning a session prunes its content.**

Postgres is already the source of truth; FTS over ~10–15 MB of text is
trivially sized. The query shape is `plainto_tsquery` with `ts_rank` ordering
and `ts_headline` for snippets.

- *Rejected: query-time grep over the platform stores.* Foreign-host rows
  (mbp) are unreachable from vps8; Hermes-pruned sessions vanish from the
  source; the Kimi store layout is uncracked; and every search re-reads
  hundreds of MB of jsonl to find kilobytes of text.
- *Rejected: use Hermes' own per-profile `messages_fts` (FTS5) tables.* They
  exist and are live, but they are N SQLite databases, per-profile, Hermes-only
  (Claude and Kimi uncovered), and they die with Hermes' own pruning. Union
  searching them is a federation project, not a search feature.
- *Rejected: a SQLite FTS5 sidecar of our own.* A second store when Postgres
  already does FTS is the _foundry lesson in reverse — one home, one owner.

### R3 — How content arrives

**Recommendation: a harvester, not hooks. A new CLI entry point (sibling to
`harvest.ts`, same posture: reads foreign stores, writes only through the HTTP
API, dry-run by default) that backfills all history on first run and then runs
incrementally — a session is re-harvested only when its `message_count` has
moved since the last harvest. High-watermark state lives in the row's
`raw_metadata`, not a new column.**

The capture hooks stay exactly as thin as they are: they fire at start/end
with metadata and never parse platform stores. All platform-specific
extraction lives in the repo, in TypeScript, testable.

- *Rejected: inline content capture in the end-event hook.* The hook is a
  shell script that must stay dumb; platform parsing in shell is how the 2.a
  wire bugs happened. The backfill needs the harvester anyway — the hook path
  would be a second ingestion path to keep honest.
- *Rejected: scheduled/daemon harvest from birth.* On-demand first, per the
  2.b "nothing runs when he isn't asking" posture. A cron line is a one-word
  amendment later; the harvester is built cron-safe (idempotent, incremental)
  either way.

### R4 — The search surface

**Recommendation: `GET /api/sessions/search?q=` — a new endpoint, separate
from the 2.b list endpoint — returning sessions ranked by `ts_rank`, each
carrying a `ts_headline` snippet, a match count, and an `indexed` flag. The
picker gains one verb: `sm find <text>`. It renders ranked rows with the
snippet line under each, then runs the identical pick → attach flow. `sm
<text>` (metadata filter) is unchanged.**

`find` is not administration; it is the resume act's front half, so it
belongs in the picker grammar — the first addition since 2.b closed it. The
closed grammar is a feature; this opens it by exactly one word.

- *Rejected: fold content matches into the main list.* Rank ordering fights
  the recency ordering that makes "row 1 is what I was just doing" true; 2.b
  ratified stable row numbers over live-first for the same reason.
- *Rejected: a separate admin/search CLI.* Splits the resume act across two
  tools; the pick seam and attach flow would be duplicated.

### R5 — Redaction / secrets posture

**Recommendation: no redaction in v1, stated plainly in the doc.**

Message text already sits in the platform stores on the same host; the index
moves a ~10% subset of it into Postgres on the same host, behind the same
bearer token, on the same tailnet boundary. No new exposure surface is
created. A pattern-based redactor is false comfort: it catches the secrets
that look like secrets and misses the rest, while teaching the user to paste
freely. The honest rule stays the one John already runs: don't paste secrets
into agent sessions.

- *Rejected: regex redaction at harvest.* See above — leak-prone theater.
- *Rejected: encrypt the content column.* Single-user, single-host; the threat
  model it answers isn't the one we have.

### R6 — Retention when the source prunes

**Recommendation: our copy outlives the source, marked, until John prunes.**

Hermes prunes its own history (2.b fixed constraint). A harvested session that
Hermes later prunes keeps its content rows here — that is a feature (the text
survives for search even when the session is no longer resumable) and the
`attach` route already degrades honestly on such rows. If John sets
`status='pruned'` on the session-minder row, the cascade deletes the content.
Curation keeps its teeth; nothing is silently lost.

## Scope — four pieces, in dependency order

1. **Schema** (`db/03-messages.sql`): `_sessionminder.messages` — `id`,
   `session_id` (FK, cascade), `role` (`user`/`assistant`), `ordinal`,
   `content`, `content_tsvector` (generated), `harvested_at`. GIN on the
   tsvector; unique on `(session_id, ordinal)`. Run as `_sessionminder_role`,
   never postgres (the _foundry ownership trap, restated in 02-tables.sql).
2. **Search endpoint** (`src/routes/search.ts`): auth, `plainto_tsquery`,
   rank + `ts_headline` snippet + match count + `indexed` flag per session.
   Sessions with no harvested content are absent from results, and the
   response carries `indexed_sessions` / `total_sessions` so the client can
   say honestly what the search covered.
3. **The harvester** (`src/cli/harvest-content.ts`): per-platform extractors —
   - *hermes*: `discoverStateDbs()` glob (existing), `messages` table,
     `role IN ('user','assistant')`, all rows regardless of `compacted` —
     compacted-away history is exactly what search is for.
   - *claude_code*: `~/.claude/projects/**/*.jsonl` matched to sessions by
     filename = `external_session_id`; `type` user/assistant, text blocks
     only.
   - *kimi_code*: **declared unknown** — `~/.kimi-code/server/instances` and a
     `search-index/` directory exist, layout uncracked. One exploration slot
     below. If it proves hostile, Phase 3 ships claude+hermes and kimi joins
     when cracked (the Phase 1 precedent: support lands when the platform is
     understood, not before).
   Incremental via `message_count` high-watermark in `raw_metadata`; dry-run
   default; `--apply` writes through the API.
4. **`sm find`** (`src/cli/`): one new verb in `args.ts`, ranked row
   rendering with a snippet line, then the existing pick seam and attach flow
   untouched.

## Declared unknowns (resolved by live verification, slots designed)

1. **Kimi store layout.** What in `~/.kimi-code/server/` holds message text,
   keyed how. One exploration pass answers it; the extractor slot exists
   either way, and shipping without kimi is the pre-agreed fallback.
2. **Headline quality on agent prose.** `ts_headline` defaults on real
   sessions — are the snippets useful or noise? Tuning (fragment length,
   delimiter) is config, decided after one look at real output.
3. **Whether `ordinal` reconstruction is stable for Claude.** jsonl is
   append-only and ordered; Hermes messages have `timestamp`. The unique key
   only needs per-session monotonicity, but this is asserted, not yet proven
   against a compacted Hermes session.

## Testing contract (binding on the implementation plan)

1. The plan authors no test bodies. Per test it states the rule pinned and
   the named mutant that must die; the implementer proves the mutant fails
   before the test counts. (House rule, carried from 2.b.)
2. Mutation treatment for the honestly unit-testable core: the extractor
   role/flag filters (a mutant admitting `tool` rows must die), the
   high-watermark incremental rule (a mutant re-harvesting unchanged sessions
   must die), rank ordering, snippet generation from fixtures, the `indexed`
   accounting.
3. **A live-verification ledger is part of done**, minimum entries:
   - The acceptance query: `sm find vps2` returns the 2026-08-20 retirement
     session ranked first, snippet drawn from John's own opening message.
   - One backfill over the full live corpus with row counts reported per
     platform, checked against the source stores.
   - One incremental run immediately after: zero re-harvested sessions.
   - One prune: a session set to `status='pruned'` no longer appears in
     search and its content rows are gone from the table.
   - One foreign-host row (mbp-captured, never harvested locally) searched:
     absent from results, accounted in the coverage counts.
4. **The service runs from source with no watcher** (CLAUDE.md gotcha):
   nothing here is live until `systemctl restart session-minder`, and the
   ledger entries run against the restarted service, not the dev process.

## Out of scope (deliberate)

- **Semantic/embedding search.** The _foundry brain lane owns meaning-based
  retrieval, and the voyage/ollama dimension mismatch there is a standing
  lesson in not buying that complexity casually. Substring/FTS answers the
  observed need ("sessions dealing with vps2").
- **Searching tool output.** Measured above as the bulk without the recall.
  If a real miss traces to tool-only content, that is a Phase 3.1 amendment
  with evidence in hand.
- **Cron-scheduled harvest.** Built cron-safe; scheduling is a later one-line
  ruling.
- **Web UI.** The picker is the surface (2.b ruling stands).
- **Cross-machine harvest orchestration.** The harvester runs wherever the
  stores are; mbp runs it on mbp, through the same API. No coordination
  layer.

## Success test

John, in a Herdr pane, types `sm find vps2`, sees the retirement session
ranked first with a snippet in his own words, types a number, and is back
inside it. The query that returned "No matching sessions" on 2026-08-20 never
returns it again for content that exists. That's the whole phase.
