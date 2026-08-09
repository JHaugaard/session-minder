# Status

_Last verified against the running system 2026-08-09._

## Where are we?

**Phase 2.a is built, deployed, and verified live.** Not just planned anymore —
the "click to jump back into a session" feature exists, is running on vps8, and
has been proven against real sessions in all three tools.

The idea, in one line: keeping track of past Claude Code, Hermes, and Kimi Code
sessions used to mean hand-maintaining three Markdown files in the vault,
updated only when you remembered. session-minder replaces that with one
automatic record in Postgres, and now a working way to jump back into any of
them.

What's live right now:

- **50 sessions captured**, 18 of them flagged as noise. By tool: 25 Claude
  Code, 24 Hermes, 1 Kimi Code.
- A new "attach" feature that takes a session and does the sensible thing with
  it: if it's still running in a Herdr pane, it switches you to that pane; if
  it isn't, it opens a fresh pane that resumes it; and if neither is possible,
  it hands you back the exact command to paste yourself. That last case isn't
  a failure — it's the fallback every session gets, never a dead end.
- All three tools were proven end to end against the real system: Claude,
  Kimi, and Hermes each spawned a genuinely resumed session through the new
  feature, confirmed by reading what actually showed up in the pane, not by
  trusting what the server reported. Claude and Kimi were further proven
  re-findable — attaching a second time switches to the existing pane instead
  of opening a duplicate.
- Only 2 of the 50 stored sessions carry the Herdr pane details the feature
  relies on. That's expected — it's only recorded for sessions started after
  today's deploy — and the number climbs on its own as you keep working.

This shipped as 12 commits (`4b4581e..1a25745`), with 72 automated tests
passing and a clean type-check.

**Three real problems were found only by testing against the live system —
every one of them had already passed the full automated test suite.** That's
worth pausing on, because it says something about how this got tested: unit
tests alone would have shipped all three.

1. The name given to a resumed session had a space in it, and Herdr's naming
   rules reject that outright.
2. That name was also the same for every session, and Herdr requires names to
   be unique among running sessions — so only one resumed session could ever
   exist at a time; a second one failed silently.
3. The two-second limit on talking to Herdr was shorter than the roughly three
   seconds Hermes actually takes to start up, so a Hermes session could never
   successfully spawn.

All three showed up to the user identically, as "Herdr unreachable" — which
was misleading, since Herdr was running fine the whole time. All three are now
fixed, and each has a test that pins the underlying rule so it can't quietly
come back.

## What's unresolved?

- **Hermes sessions can only ever be spawned fresh, never re-focused.** Herdr
  doesn't report a session id for Hermes panes — confirmed by watching a live
  one, not assumed — so a running Hermes session can't be recognized as
  "already open." Attaching to one always opens a second pane. Claude and Kimi
  don't have this problem. This should shape what the dashboard offers for
  Hermes.
- **A spawned pane can land on a prompt instead of a working session.** A test
  spawn of Kimi stopped at its own "Trust this folder?" gate and sat there
  waiting for a keystroke. Not a bug in this code, but the dashboard shouldn't
  promise that clicking a session always drops you into something ready to
  use.
- **Every kind of Herdr failure currently reports the same generic message,
  "Herdr unreachable."** That's exactly what made today's three bugs hard to
  track down and cost real time. Teaching the system to tell "Herdr isn't
  running" apart from "Herdr refused this specific request" is the recommended
  first thing to do in the next phase.
- **Not every Hermes session we've recorded can still be resumed.** Hermes
  quietly prunes its own session history, so some older captured sessions will
  fail to resume even though session-minder still holds their id.
- **Noise thresholds** (under 60 seconds, under 3 messages) are still the
  original conservative guess. 18 of 50 sessions are now flagged — worth
  tuning before the dashboard makes them visible.
- **The three old Markdown index files in the vault are still sitting there**
  untouched. Retiring them is a later decision, not urgent.

## Incoming dependency (noted 2026-08-07, unchanged)

The Honcho curation agent needs a reliable trigger. Hooking it to session-end
was considered and rejected — that would re-tangle capture and curation, which
this project deliberately keeps separate. The agreed shape instead: Honcho
curation reads *from* session-minder's table, either as a dashboard action or a
periodic sweep over unreviewed, non-noise sessions. Fold this into the
dashboard conversation when it opens.

## What's next?

**Phase 2.b — the dashboard — is the next conversation, with no remaining gate
before starting it.** It will be designed against the attach feature that now
actually exists, rather than around the "copy this command" placeholder that
used to be the plan.

Worth doing early in that work: the error-reporting fix mentioned above, so the
dashboard isn't stuck showing "Herdr unreachable" for every kind of failure the
way today's diagnosis was.

Optional and cheap whenever you feel like it: tune those noise thresholds.
