import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_SRC, tsFiles } from './helpers';

// CLAUDE.md rule 5: engine source never contains literal physician, consult, hospital or event IDs.
const ID_LITERAL = /\b(PHY|CON|SYN|EVT)-\d+/;

describe('no hard-coded IDs in packages/engine/src', () => {
  it('the pattern catches every ID shape used in the data', () => {
    for (const id of ['PHY-001', 'CON-2101', 'SYN-012', 'EVT-01161']) expect(ID_LITERAL.test(`x ${id} y`), id).toBe(true);
    expect(ID_LITERAL.test('SYN-\\d+')).toBe(false);
  });

  it('no engine source file matches /\\b(PHY|CON|SYN|EVT)-\\d+/', () => {
    const files = tsFiles(ENGINE_SRC);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (ID_LITERAL.test(line) ? [`${relative(ENGINE_SRC, f)}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
