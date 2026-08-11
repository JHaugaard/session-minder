# Status

_Last updated 2026-08-10, end of the Phase 2.b build session._

## Where are we?

**Phase 2.b is built, deployed, and live-verified.** `sm` exists. You run it in
any Herdr pane, it prints your 15 most recent resumable sessions with the noisy
ones hidden, you type a number, and it either jumps you to the live pane or
opens a freshly resumed one — or hands you the exact command to paste when
that's the honest best answer.

The plan's eight tasks all landed, one commit each, direct to main. The suite
went from 79 tests to 147. Every test the plan specified was written as a rule
plus the wrong implementation it must catch, and every one of those wrong
implementations was actually applied and watched to fail before the test
counted — 46 of them. No new dependencies.

The service was restarted onto the new code at 22:55 EDT and `/api/sessions`
flipped 404 → 200. Attaches were then run for real, one per platform, through
the real picker: Claude focused a live pane, Claude spawned a resumed one whose
scrollback held the actual old conversation, Hermes focused (see below), and
Kimi spawned. Every tab created during testing was closed; the pane baseline is
byte-identical to where it started.

The full ledger — every number, every verbatim observation — is in
`.superpowers/sdd/2026-08-10-session-minder-phase2b-picker/progress.md`.

## What we learned that we didn't know this morning

**Hermes can be focused after all.** The spec carried this as a fixed,
live-verified, not-revisitable constraint: Herdr never reports a session id for
a Hermes pane, so Hermes is spawn-only forever. That is no longer true — on the
same Herdr 0.7.5, two of four Hermes panes reported their session id, and a live
Hermes session focused cleanly through the deployed service. The design
predicted this exact possibility and needs no code change; the join was always
generic. What's now wrong is the documentation: the gotchas block in CLAUDE.md
and the constraint list in the spec both still state the dead rule.

**Both declared unknowns are answered.** Kimi's trust gate cannot be detected —
Herdr reports `interactive_ready: true` and `agent_status: idle` for an agent
sitting at "Trust this folder?", the same values a healthy pane reports. So the
standing caveat on every spawn stays, exactly as the spec said it would if the
answer came back negative. And resuming a Hermes id that Hermes has pruned
produces no error at all: the pane opens, prints "Session not found", and drops
you into a brand-new Hermes session. `sm` says "Opened a resumed pane", which is
true about the pane and false about the resume.

**The error split earned itself on the first live run.** A failed attach printed
`Herdr refused: agent target pane w9:pE is not an available shell` — Herdr's own
words. Before this phase that same failure would have read "Herdr unreachable"
with the cause thrown away, which is the thing that cost a day in 2.a.

## What's unresolved?

- **Four findings, none blocking, none acted on** (the standing gate says no code
  change from a live finding without showing you the diagnosis first):
  1. The `agent_name_taken` message tells you "Herdr can't jump to Hermes panes."
     That's now wrong twice — Herdr can, and the collision was observed on Kimi.
     Worth a one-line rewrite.
  2. `msgs` is an em dash on every row and always will be: no hook has ever sent
     `message_count`. Half the substance signal the design wanted is absent.
  3. Pruned-Hermes resume reports success (above). Detecting it would mean
     asking Hermes before attaching, which crosses the boundary the design drew.
  4. Rapid back-to-back spawns can hit a pane before its shell is ready. One
     attach immediately after succeeded, so it's a race under repetition, not a
     persistent fault.
- **Documentation owed:** correct the Hermes constraint in CLAUDE.md and the 2.b
  spec.

## Housekeeping still owed (your authority)

- Delete the synthetic row `phase2a-verify-20260809-133128` — still present, and
  it shows up in `sm --all`.
- Add the alias:
  `alias sm='npx tsx /home/john/dev/active/session-minder/src/cli/sm.ts'`
- Rotate `SESSION_MINDER_TOKEN` (open since 2.a).
- Commit the boundary-verification rule sitting uncommitted in idea-foundry-ops.

## What's next?

Use it for a week and let the list tell you what's wrong with it. The two
follow-ups the design already created are still parked and still make sense:
retarget `/index-session` to write `title` onto the session's row instead of the
three markdown index files (that's also the moment to retire those files), and
the Honcho curation sweep that reads from the sessions table. Noise thresholds
are still the original guess — `sm --all` is your window for judging them, and
now you have one.
