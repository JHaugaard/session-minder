// src/cli/args.ts
// Pure argv parsing, kept apart from everything that touches the network so it
// can be tested as plain data in and plain data out.
//
// The whole grammar: `sm` · `sm <free text>` · `sm --all`. Nothing else is
// accepted because nothing else was designed — the picker resumes, it does not
// administer.

export interface ParsedArgs {
  q: string | undefined;
  all: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const words: string[] = [];
  let all = false;

  for (const token of argv) {
    if (token === '--all') {
      all = true;
      continue;
    }
    words.push(token);
  }

  return {
    // `undefined`, not `''` — an empty filter and no filter are different
    // requests, and the route branches on exactly that distinction.
    q: words.length > 0 ? words.join(' ') : undefined,
    all,
  };
}
