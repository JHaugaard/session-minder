// src/cli/pick.ts
// The pick seam: rows in, chosen row out. Everything above this file works in
// numbers, so an alternate picker (fzf, if it ever earns its way in) implements
// this exact signature and nothing else in the CLI changes.
//
// This is also the one part of the picker a unit test cannot reach — it wants a
// TTY. Task 8's live smoke is its coverage, deliberately.
import readline from 'node:readline/promises';

const MAX_ATTEMPTS = 3;

/**
 * Returns the 1-BASED row number typed, or null to cancel.
 *
 * Null on: empty input, `q`, EOF (Ctrl-D), or a third consecutive answer that
 * isn't a whole number in range. Cancelling is always free — nothing is
 * resumed on a keystroke used to back out.
 */
export async function pick(rowCount: number): Promise<number | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const answer = (await rl.question('Pick # (enter to cancel): ')).trim();
      if (answer === '' || answer.toLowerCase() === 'q') return null;

      const n = Number(answer);
      // `Number.isInteger` rejects NaN, '3.5' and Infinity in one check. The
      // range test is what keeps a typo from indexing past the list.
      if (Number.isInteger(n) && n >= 1 && n <= rowCount) return n;

      process.stdout.write(`Enter a number from 1 to ${rowCount}, or press enter to cancel.\n`);
    }
    return null;
  } catch {
    // rl.question rejects on EOF — Ctrl-D is a cancel, not a crash.
    return null;
  } finally {
    rl.close();
  }
}
