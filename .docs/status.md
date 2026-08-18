# Status

_Last updated 2026-08-18, at the end of the harvest + Herdr session._

## Where are we?

**`sm` works, and it finally has names in it.** Run it in any terminal, see
your recent resumable sessions with the noisy ones hidden, type a number, and
it jumps you to the live pane or opens a freshly resumed one. That much has
been true since 2026-08-11.

What changed this week is that the list is now worth searching. A week after
titles shipped, only 5 of 112 captured sessions had names — all Claude Code,
none Hermes. The manual-naming experiment had answered its own question.

But Hermes titles its own sessions, so rather than build a summarizer, the
cheap move was to go take what already existed. There's now a harvester that
reads Hermes' own stores and fills in the blanks. It runs as a dry run by
default and prints every title it would write; `--apply` is the only thing that
writes anything. It set 37 titles, failed on nothing, and a second run wrote
nothing at all — it fills blanks, it never overwrites a name you typed.

`sm miles` now returns five Miles Davis sessions. `sm syncthing` returns two.
Neither worked before this week.

**A bug was also found and fixed that had been quietly breaking the picker.**
Every "live" dot was missing — the tool couldn't tell you which sessions were
already open in front of you. The cause was that you have three Herdr servers
running at once, and session-minder was talking to whichever answered first,
which happened to be one holding a single pane and none of your actual work.
It reported itself as perfectly healthy while doing this.

That was not just cosmetic. Because the live pane was invisible, picking a
session that was *already open* would have opened a **second** copy beside it.
The service now checks every Herdr server, and prefers the one a session was
originally captured in. Verified after restarting: zero live markers before,
six after, including the session this was written from.

**The Herdr agent skill is installed.** It teaches an agent already running in
a Herdr pane to control Herdr — split a pane, start another agent, prompt it,
read its output. It's one markdown file, hand-installed and pinned to a
specific upstream version, with a provenance note recording where it came from
and how to check for drift. It does nothing outside a Herdr pane.

One thing to know about it: agents you start through that skill get captured by
session-minder like any other session, so they'll show up in `sm` as ordinary
untitled rows. That's arguably correct — they really are resumable sessions —
but it's a change you'll notice.

Everything is committed. Nothing is pushed. The test suite is at 196, up from
157, and every new test was checked by deliberately breaking the code to
confirm the test noticed.

## What's unresolved?

Nothing blocking. The known-and-deliberately-unfixed list:

- **The big one, and it's your call: should session end automatically write an
  AI-generated summary of what happened?** Everything above is groundwork for
  the original idea — asking a prompt "find Hermes sessions from last week
  where we worked on xyz" and getting real candidates back. Harvested titles
  get you part of the way. Generated summaries get you the rest. The reason
  this isn't decided is The Beav: those are OSU contract and regulatory review
  sessions, and auto-summarizing them puts work content into the database.
  Probably fine — your machine, your network, single user — but it deserves a
  deliberate yes rather than happening by default.
- **Only Hermes can be harvested.** Claude Code and Kimi write no titles of
  their own, so their sessions still depend on `/index-session`.
- **The harvest dry run over-lists.** It shows 282 candidates when 37 will be
  written, and says so plainly in its own output. It can't tell which Hermes
  sessions were captured without a change to the API. `--apply` is exact, so
  this is polish.
- **`msgs` is always empty.** No capture hook has ever sent a message count.
- **Resuming a Hermes session Hermes has forgotten looks like it worked.** The
  pane opens, prints "Session not found", and drops you into a new session.
  Glance at the pane before typing.
- **A spawned pane can be sitting at a prompt** (Kimi's "Trust this folder?").
  Herdr reports a stalled agent as ready, so this can't be detected.
- **You have a stale Herdr session directory** called `herdr-4-up` — note the
  extra hyphen — sitting next to the real `herdr-4up`. Harmless now that the
  service checks all servers, but it's leftover clutter from a typo.

## What's next?

**Use the names for a week before building anything else.** That's the whole
reason for harvesting first: to find out whether title-grade text actually
answers "where did we work on xyz" before committing to a summarization
pipeline. Search the corpus and notice where it comes up empty — that tells
you precisely what a generated summary would need to add, which is a far
better specification than guessing at one now.

If you do decide to go ahead, the design is already worked out:

- **Step 2** — add summary, keywords, and timestamp columns (never touching
  `note`, which is yours), plus platform and date-range filters on the list.
- **Step 3** — an out-of-band summarizer using `claude -p` under your
  subscription rather than a metered API, then the skill that turns a
  natural-language question into candidates in the thread.

Two housekeeping items whenever you feel like it: push these three commits, and
delete the stale `herdr-4-up` directory.

One last thing, and it's a correction to the maintenance rule rather than a
confirmation of it. The rule has been "when Herdr updates, run the tests *and*
do one real `sm` attach and look at the pane." This week showed that trigger is
wrong twice over. Neither failure involved a Herdr release: one was **Hermes**
moving its session store, and the other was **your own machine drifting** —
extra Herdr servers accumulating, no software updated at all. A check that
fires on version bumps can never catch facts that expire without one.

The instrument was wrong too. The service reported `herdr: ok` the entire time
every live marker was false, because answering a ping proves a server is *up*,
not that it's the *right* one.

So the honest version: **periodically run one real `sm` attach and look at the
pane — on a calendar, not on a release.** And treat any health signal that only
proves "something answered" as no signal at all.
