// src/cli/outcome.ts
// One message per outcome, no optimism. Every sentence here is the last thing
// John reads before deciding whether the tool worked, so each one says exactly
// what happened and — when the answer is "not what you wanted" — hands over the
// command that will.
import type { AttachResponse, SessionSummary } from './api.js';

export interface Outcome {
  lines: string[];
  // Always 0. Every outcome above is the server answering successfully; a
  // degrade is a valid answer, not a failure. Nonzero is reserved for the
  // picker's own failures (no service, bad token), which never reach here.
  exitCode: 0;
}

// Commands always occupy a line of their own. Embedded mid-sentence they can't
// be double-clicked or copied cleanly, which defeats the only purpose a degrade
// response has.
function withCommand(sentence: string, command: string | null): string[] {
  return command === null ? [sentence] : [sentence, '', `  ${command}`, ''];
}

export function renderOutcome(r: AttachResponse, session: SessionSummary): Outcome {
  const lines = render(r, session);
  return { lines, exitCode: 0 };
}

function render(r: AttachResponse, session: SessionSummary): string[] {
  if (r.action === 'focused') {
    return [`→ pane ${r.pane_id}`];
  }

  if (r.action === 'spawned') {
    return [
      `Opened a resumed pane (${r.pane_id}).`,
      'If the pane is waiting at a prompt (e.g. a trust gate), answer it there.',
    ];
  }

  switch (r.reason) {
    case 'herdr_unreachable':
      return withCommand("Herdr can't be reached — paste this into any pane:", r.command);

    case 'herdr_rejected':
      // Matched on the CODE, never on the message text. Herdr's wording is
      // Herdr's to change at any release; the code is the contract. A prose
      // match would silently degrade this honest answer into the generic one
      // the first time Herdr rewrites a sentence.
      if (r.herdr_code === 'agent_name_taken') {
        return withCommand(
          'This session appears to be running in another pane already. ' +
            "Herdr can't jump to Hermes panes — switch to it by hand, or paste:",
          r.command
        );
      }
      // Herdr's own message, shown rather than paraphrased. Showing it is the
      // entire point of splitting the error type in the first place.
      return withCommand(`Herdr refused: ${r.herdr_message ?? 'no reason given'}`, r.command);

    case 'foreign_host':
      // The host comes from the picked row, not the response: the row is
      // already in hand at the call site, and it keeps the server from having
      // to echo back something the client just sent it.
      return withCommand(`Captured on ${session.host} — run it there:`, r.command);

    case 'no_project_path':
      return withCommand(
        'No recorded project directory — run this from wherever it belongs:',
        r.command
      );

    case 'not_resumable_platform':
      // No command exists for this one, and withCommand's null branch is what
      // keeps a blank line from appearing where a copyable command would be.
      return ["This session can't be resumed (unknown platform)."];
  }
}
