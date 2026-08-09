# Status

_Last verified against the running system 2026-08-09._

## Where are we?

**Phase 1 is built, deployed, and capturing from all three tools. Phase 2.a is
fully planned but not yet built.**

The idea, in one line: keeping track of past Claude Code, Hermes, and Kimi Code
sessions used to mean hand-maintaining three Markdown files in the vault,
updated only when you remembered. session-minder replaces that with one
automatic record in Postgres, with a browsable dashboard to come.

What's live right now:

- A Postgres table on vps8 holding every session, and a small web service that
  the three tools' hooks POST to when a session starts and ends. It runs as a
  background service on vps8, reachable only over Tailscale.
- **48 sessions captured** since Aug 3, 18 of them auto-flagged as noise.
- All three tools are confirmed capturing end to end. Kimi was the last
  holdout, and it's now proven with a real captured session — that was the one
  step left unchecked from the original Phase 1 plan.

New this session: **Herdr is fully wired in.** All three Herdr integrations
(Claude, Hermes, Kimi) are installed, and each one added its hooks *alongside*
session-minder's rather than replacing them — which was the main risk. That was
the thing blocking the "click to jump back into a session" feature, and it's
now cleared.

Two useful things came out of poking at the live system rather than the docs:
Herdr genuinely does hand us the same session ID our own hooks record, so the
two systems can be joined reliably; and all three tools turn out to have a
working resume command, which we confirmed by reading each one's own `--help`
rather than assuming.

There is a complete, step-by-step build plan sitting ready. Nothing in it has
been implemented yet — that's deliberate, so the build happens in its own
session.

## What's unresolved?

- **Nothing is blocking the build.** The plan is written and reviewed; the next
  session executes it.
- **Two small unknowns will surface during the build, both flagged in the plan
  with what to do about them.** One is whether Kimi's resume flag behaves the
  way its help text implies. The other is whether resuming a Hermes session
  that originally came from Telegram is actually useful in a terminal — that's
  a question about what the future dashboard should offer, not a bug.
- **Noise thresholds** (under 60 seconds, under 3 messages) are still the
  original conservative guess. 18 of 48 sessions are now flagged, which is a
  lot. Worth tuning before the dashboard makes them visible.
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

**Start a fresh session and run the Phase 2.a build.** The handoff prompt was
written at the end of this session — it points at the plan, sets the execution
approach, and lists the three points where the build should stop and ask you.
It's in the conversation transcript; if you've lost it, ask for it again and
it'll be regenerated from the plan.

The build is six tasks. The first five are pure code and should run
unattended with review gates between them. The sixth is hands-on: it needs
your sudo for a service restart, and it spawns real panes in your live Herdr
workspace to prove the feature works.

After that, Phase 2.b — the actual dashboard — is the next conversation, and
it will be designed against the attach contract this build creates rather than
around a "copy this command" placeholder.

Optional and cheap whenever you feel like it: tune those noise thresholds.
