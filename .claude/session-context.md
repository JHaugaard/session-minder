# Session Context

## Current Focus

Started as a design question: expose session-minder's data to *prompts* as a
routing table — "find Hermes sessions from last week where we worked on xyz",
answered in-thread. It became three things: Step 1 of that idea built and
shipped, the Herdr agent skill vendored, and a live bug fixed that had been
quietly breaking the picker.

## Honcho Context

Queried `peer=john` at session start (dialectic, low). Positions that shaped
the work:

- **Explicit, visible retrieval is the standing preference.** John once told an
  assistant outright to *stop* searching session history. This argued for an
  invoked skill over an always-loaded MCP tool, and for a dry-run-by-default
  harvester rather than a silent bulk write.
- **session-minder's settled purpose is resumption, not memory.**
- **He accepts bounded automation that leaves a trace** but rejects invisible
  background work.

## Key Decisions

- **Harvest before generating.** 5 of 112 sessions had names after a week of
  manual titling, so auto-summarization was clearly right — but Hermes already
  titles its own sessions, so the cheap move was to harvest those first and
  learn whether title-grade text is enough before building a summarizer.
- **Dry run is the default; `--apply` writes.** Deliberate, given the stated
  dislike of bulk approvals.
- **`if_absent` on the title route** so a re-run tops up blanks instead of
  flattening curation. Default stays destructive — `/index-session` exists to
  correct a name.
- **Skill installed by hand, not via `npx skills add`.** One markdown file; a
  third-party installer's write footprint buys nothing. Pinned + provenance
  file, following the existing `UPSTREAM-*` convention.
- **Auto-generated summaries at session end are approved in principle but not
  built.** The Beav's OSU contract sessions are why that deserves a deliberate
  answer rather than a default. Still open.

## Notes

- Session started 2026-08-14 12:03 EDT, closed 2026-08-18.
- Three commits: `269552b` (harvest), `5fc7cd9` (Herdr socket fix),
  `ea0f0ed` (skills repo). **Nothing pushed** — still local.
- Test suite 157 -> 196. 34 mutants applied across the session, 34 caught.
  Two candidate tests were discarded for failing to discriminate.
- The socket bug was found by accident, while checking that the newly
  installed Herdr skill's view of the world agreed with session-minder's. It
  had been silently breaking `sm` for some time.
