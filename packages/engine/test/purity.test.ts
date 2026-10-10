import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_SRC, tsFiles } from './helpers';

// CLAUDE.md rule 3: no Date.now(), no Math.random(), no I/O except src/data/loaders.ts.
const FORBIDDEN: readonly [string, RegExp][] = [
  ['Date.now()', /\bDate\.now\s*\(/],
  ['new Date(', /\bnew\s+Date\s*\(/],
  ['Math.random()', /\bMath\.random\s*\(/],
];
const IO_IMPORT = /from\s+['"](node:)?(fs|fs\/promises|path|http|https|net|child_process)['"]/;
const IO_ALLOWED = 'data/loaders.ts';

const sources = tsFiles(ENGINE_SRC).map((f) => ({ path: relative(ENGINE_SRC, f), text: readFileSync(f, 'utf8') }));

describe('engine purity', () => {
  it('uses no wall clock and no unseeded randomness', () => {
    const hits = sources.flatMap((s) => FORBIDDEN.filter(([, re]) => re.test(s.text)).map(([name]) => `${s.path}: ${name}`));
    expect(hits).toEqual([]);
  });

  it(`does I/O only in src/${IO_ALLOWED}`, () => {
    const hits = sources.filter((s) => s.path !== IO_ALLOWED && IO_IMPORT.test(s.text)).map((s) => s.path);
    expect(hits).toEqual([]);
  });
});
