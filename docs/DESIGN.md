# Lookahead design system

A dark operations console that reads at a glance on a projector and in a dim operations room, with a Day theme for print and bright rooms. Every number on screen is engine output; the design never adds a number of its own.

## Foundations

- **Color carries meaning only.** `critical` (alarm), `warning` (caution), `accent` (action, teal), `ok`, `info`. Teal is reserved for things you can act on and for the Horizon Line's future axis. Everything else is ink on surfaces.
- **Ink levels.** `text` (ink), `muted` (ink-2: labels, metadata), `ink3` (ink-3: citations, axis ticks). Every text token meets WCAG AA (4.5:1) on the surfaces it is used on, in both themes; `apps/web/test/contrast.test.ts` enforces it and checks that `globals.css` and `src/ui/tokens.ts` hold the same values.
- **Never color alone.** Priority has a shape (P1 filled diamond, P2 filled triangle, P3 hollow square, P4 hollow circle). Every status pill has a shape and a word. Coverage classes keep their hatch patterns.
- **Geometry.** 4 px grid, 2 px radius, hairline borders, no shadows. Type: IBM Plex Sans for text, Plex Mono with tabular numerals for IDs, times and numbers. Scale 11 / 13 / 15 / 18 / 22 / 28 / 44.
- **Motion.** Only change flashes and the critical pulse; both stop under `prefers-reduced-motion`. Loading states are quiet rule lines, not shimmer.
- **Focus.** A 2 px action outline on every focusable element; a skip link on every page.

## Token table

Values live in `apps/web/src/ui/tokens.ts`; `pnpm --filter web exec vitest run test/contrast.test.ts` prints any token below AA.

| Token | Night | Day | Use |
|---|---|---|---|
| bg | #0b1320 | #f4f6f9 | page |
| panel | #121c2e | #ffffff | panels |
| raised | #1a2740 | #eaeef3 | rows, inputs |
| border | #263552 | #cfd7e1 | hairlines |
| text (ink) | #e8eef5 | #0f1a2a | primary text |
| muted (ink-2) | #93a4b8 | #475569 | labels |
| ink3 (ink-3) | #8193a8 | #5b6878 | citations, ticks |
| accent (action) | #2bb3a3 | #0b7266 | actions, now-axis |
| critical (alarm) | #f2555a | #b91c25 | P1, gaps, deadlocks |
| warning (caution) | #f5a524 | #8a5300 | P2, surges, shift ends |
| ok | #3fb68b | #17734a | resolved, active |
| info | #6ea8fe | #1d4fa8 | P3, delivered, expiries |

## Kit (`apps/web/src/ui/`)

`kit.tsx`: Button (primary, secondary, destructive, ghost; phone size with 48 px targets), Chip (semantic and ID), PriorityGlyph, StatusPill, SectionTitle, Rule, KitPanel, AnalogBar (value against the p90 normal band; caution or alarm only when abnormal), Pips (filled = available, hollow = required but missing), Sparkline, EmptyState, ErrorState, LoadingRules, Modal. `HorizonLine.tsx`: the signature element. `/design` renders every component in every state, in Night and Day, on live engine data; it is the screenshot target.

## The Horizon Line

One axis from now − 30 to now + 180 minutes. The past is faint, "now" is a fixed edge at about 14 % from the left, and the future axis is the only teal line on screen. Markers come from the engine's horizon timeline (D-95): shift ends as brackets labelled with a computed "−N physicians", confirmed and expected arrivals as solid and dashed brackets, forecast surge windows as hatched bands whose opacity is P(spike), projected gaps as a red segment under the line, offer and standby expiries as hourglasses, recommended action deadlines as teal flags with the engine's sentence. Labels sit on two lanes above and two below and are placed greedily so they never overlap (`test/horizonLine.test.ts`); a label that cannot be placed stays in the marker's tooltip and the SVG's text summary.

## Plan and self-review

Order of work (each step ends green and pushed):

1. Tokens, Day theme, contrast test, kit, `/design` (done in this pass).
2. App shell: the Horizon Line across the top of the command center, the patient clock band, the status line, and the detail column.
3. Pages through the kit: `/opener`, `/rewind`, the phone pages and `/lead`, then `/architecture`, the Stress Test panel, `/simulator`, `/quality`.
4. Command palette, shortcuts sheet, density toggle, embed theming.

Self-review against common failure modes of generated interfaces:

- Decorative color, gradients and glow: none; color appears only where a token's meaning applies.
- Centered hero layouts and oversized empty space: the opener is left-aligned; the console keeps its dense three-column grid.
- Placeholder numbers and lorem text: impossible by construction; components take engine DTOs, and `/design` uses the live view.
- Labels colliding on charts: the Horizon Line's lane placement is tested.
- Ambiguous status: every status has a shape and a word.
