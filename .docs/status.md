# Status

_Last updated 2026-08-11, end of the titles + rotation session._

## Where are we?

**`sm` is finished and in daily use, and it writes titles now.** You run it in any
terminal, it prints your most recent resumable sessions with the noisy ones
hidden, you type a number, and it jumps you to the live pane or opens a freshly
resumed one — or hands you the exact command to paste when that's the honest
best answer. You used it all day on 2026-08-11 and called it great.

Three things happened today on top of yesterday's build.

**Titles work end to end.** There's now one write surface — a title endpoint on
the service — and `/index-session` has been rewritten to use it. Your gesture is
unchanged: `/index-session some-label` mid-session. The label becomes the name
the picker shows; the one-line summary goes into the `note` column, which existed
but had never been written to. Re-running replaces the title, so a bad label is
correctable. The three markdown session-index files in the vault are no longer
written — they sit on disk as history, and nothing reads them.

That rewrite also fixed a real bug you never saw. The old skill guessed which
session you were in by taking the most recently modified transcript file in the
project folder. This project has ten. It gave the right answer every time you
used it and would have kept doing so until the day two sessions were open at
once. It now reads the session id Claude Code actually exports.

**The token is rotated.** It turned out to live in six files, not one — the
project's `.env.local`, Claude Code's settings, and four Hermes env files. All
six now carry a new one, and the old one is dead (the service rejects it). Stale
copies in two old backup files were deleted. Copies that survive in a Hermes
database and a handful of session transcripts can't be edited, but rotating is
what made them worthless.

**The documentation now matches reality.** Yesterday's live testing killed a
"fixed constraint" — Hermes sessions *can* be focused. CLAUDE.md is corrected,
the ratified spec carries a dated addendum rather than a rewrite, and the one
user-facing message that repeated the false claim has been fixed.

Everything is committed and pushed. The test suite is at 157, up from 79 two days
ago, and every test names the specific wrong implementation it would catch.

## What's unresolved?

Nothing blocking. Four things are known and deliberately not fixed:

- **`msgs` will always be empty.** No capture hook has ever sent a message count.
  The column shows an em dash on every row and will until a hook sends one.
- **Resuming a Hermes session that Hermes has already forgotten looks like it
  worked.** The pane opens, prints "Session not found", and drops you into a new
  session, while `sm` says "Opened a resumed pane." Glance at the pane before you
  start typing. Nothing in the database can predict which Hermes ids are still
  alive.
- **A spawned pane can be sitting at a prompt** (Kimi's "Trust this folder?").
  This cannot be detected — Herdr reports a stalled agent as ready and idle,
  identical to a healthy one. That's why every spawn carries the caveat line.
- **Two rapid-fire attaches in a row** can hit a pane before its shell is up. A
  single attach right after succeeded, so it's a race under repetition.

Two follow-ups from the original design are still parked: retiring the three
markdown index files (they're dead but hold summaries predating the database —
your call, no rush), and the Honcho curation sweep that would read from the
sessions table. That one reads better now that titles exist.

## What's next?

Nothing, deliberately. Use it for a week and name the sessions worth naming.
That's the only way to learn whether 60 characters is the right title limit,
whether splitting a label from a paragraph holds up in practice, or whether the
noise thresholds need moving — `sm --all` is your window on that last one.

Maintenance is two habits and nothing else. Push after any session that changes
code; today's gap had grown to eight days and two entire phases living on one
machine. And when Herdr updates, run the tests *and* do one real `sm` attach and
look at the pane — a green suite has now twice failed to notice that Herdr
changed underneath it.

If you find yourself doing more than that, it's the infrastructure reflex rather
than the project asking for anything.
