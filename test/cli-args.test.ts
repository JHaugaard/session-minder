// test/cli-args.test.ts
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli/args.js';

describe('parseArgs', () => {
  it('joins free-text tokens into a single filter', () => {
    // `sm jazz canon` is one filter, not two. Keeping only the first token
    // would quietly search for "jazz" and show rows John did not ask for,
    // with nothing on screen admitting the second word was dropped.
    expect(parseArgs(['jazz', 'canon'])).toEqual({ q: 'jazz canon', all: false });
  });

  it('treats --all as a flag, never as filter text', () => {
    // If `--all` fell through into `q`, it would become a substring search for
    // the literal "--all" — zero matches, and the escape hatch silently dead.
    expect(parseArgs(['--all'])).toEqual({ q: undefined, all: true });
  });

  it('accepts --all in any position alongside a filter', () => {
    expect(parseArgs(['--all', 'jazz'])).toEqual({ q: 'jazz', all: true });
    expect(parseArgs(['jazz', '--all'])).toEqual({ q: 'jazz', all: true });
  });

  it('leaves q undefined when there is nothing to filter on', () => {
    // undefined, not '': an empty string is a filter matching everything with
    // a non-null column, which is not the same as no filter at all.
    expect(parseArgs([])).toEqual({ q: undefined, all: false });
  });
});
