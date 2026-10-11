/**
 * Design tokens (UI pass, docs/DESIGN.md): the single source for both themes.
 * globals.css carries the same values as CSS variables (Tailwind 4 @theme for
 * Night, [data-theme="day"] overrides for Day); test/contrast.test.ts checks
 * that the two agree and that every text token meets WCAG AA on every
 * surface it is used on. Semantic names: alarm (critical), caution (warning),
 * action (teal: the only interactive accent), ok, info; ink / ink-2 / ink-3
 * are the three text levels (ink-2 = the existing "muted").
 */

export type ThemeName = 'night' | 'day';

export interface Palette {
  readonly bg: string;
  readonly panel: string;
  readonly raised: string;
  readonly border: string;
  /** ink: primary text. */
  readonly text: string;
  /** ink-2: secondary text (labels, metadata). */
  readonly muted: string;
  /** ink-3: tertiary text (citations, axis ticks); AA on bg and panel. */
  readonly ink3: string;
  /** action: teal, interactive elements and the "now" line only. */
  readonly accent: string;
  /** alarm */
  readonly critical: string;
  /** caution */
  readonly warning: string;
  readonly ok: string;
  readonly info: string;
}

export const THEMES: Readonly<Record<ThemeName, Palette>> = {
  night: {
    bg: '#0b1320',
    panel: '#121c2e',
    raised: '#1a2740',
    border: '#263552',
    text: '#e8eef5',
    muted: '#93a4b8',
    ink3: '#8193a8',
    accent: '#2bb3a3',
    critical: '#f2555a',
    warning: '#f5a524',
    ok: '#3fb68b',
    info: '#6ea8fe',
  },
  day: {
    bg: '#f4f6f9',
    panel: '#ffffff',
    raised: '#eaeef3',
    border: '#cfd7e1',
    text: '#0f1a2a',
    muted: '#475569',
    ink3: '#5b6878',
    accent: '#0b7266',
    critical: '#b91c25',
    warning: '#8a5300',
    ok: '#17734a',
    info: '#1d4fa8',
  },
};

/** Text tokens and the surfaces each must read on (WCAG AA 4.5:1 for body text). */
export const TEXT_ON: readonly { readonly fg: keyof Palette; readonly on: readonly (keyof Palette)[] }[] = [
  { fg: 'text', on: ['bg', 'panel', 'raised'] },
  { fg: 'muted', on: ['bg', 'panel', 'raised'] },
  { fg: 'ink3', on: ['bg', 'panel'] },
  { fg: 'accent', on: ['bg', 'panel'] },
  { fg: 'critical', on: ['bg', 'panel'] },
  { fg: 'warning', on: ['bg', 'panel'] },
  { fg: 'ok', on: ['bg', 'panel'] },
  { fg: 'info', on: ['bg', 'panel'] },
];

export const AA_TEXT = 4.5;

/** WCAG 2.x relative luminance and contrast ratio. */
export function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Type scale (px) and the 4 px spacing grid. */
export const TYPE_SCALE = { micro: 11, small: 13, body: 15, h3: 18, h2: 22, h1: 28, display: 44 } as const;
export const GRID_PX = 4;
