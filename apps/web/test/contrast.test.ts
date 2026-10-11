import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AA_TEXT, type Palette, TEXT_ON, THEMES, contrast } from '@/ui/tokens';

/**
 * Token contract (UI pass, docs/DESIGN.md): every text token reads at WCAG AA
 * (4.5:1) on each surface it is used on, in Night and Day; globals.css holds
 * exactly the values of src/ui/tokens.ts.
 */

const CSS = readFileSync(fileURLToPath(new URL('../src/app/globals.css', import.meta.url)), 'utf8');
const CSS_NAME: Record<keyof Palette, string> = { bg: 'bg', panel: 'panel', raised: 'raised', border: 'border', text: 'text', muted: 'muted', ink3: 'ink3', accent: 'accent', critical: 'critical', warning: 'warning', ok: 'ok', info: 'info' };

function block(selector: RegExp): string {
  const m = selector.exec(CSS);
  if (m === null) throw new Error(`no ${selector.source} block in globals.css`);
  return CSS.slice(m.index, CSS.indexOf('}', m.index));
}

describe('design tokens', () => {
  for (const theme of ['night', 'day'] as const) {
    it(`${theme}: every text token meets AA on its surfaces`, () => {
      const p = THEMES[theme];
      const failures: string[] = [];
      for (const { fg, on } of TEXT_ON) for (const s of on) if (contrast(p[fg], p[s]) < AA_TEXT) failures.push(`${fg} on ${s}: ${contrast(p[fg], p[s]).toFixed(2)}`);
      expect(failures).toEqual([]);
    });
  }

  it('globals.css matches tokens.ts in both themes', () => {
    const night = block(/@theme\s*\{/);
    const day = block(/html\[data-theme='day'\]\s*\{/);
    for (const [key, name] of Object.entries(CSS_NAME) as [keyof Palette, string][]) {
      expect(night, `night --color-${name}`).toContain(`--color-${name}: ${THEMES.night[key]};`);
      expect(day, `day --color-${name}`).toContain(`--color-${name}: ${THEMES.day[key]};`);
    }
  });

  it('contrast() matches known WCAG values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});
