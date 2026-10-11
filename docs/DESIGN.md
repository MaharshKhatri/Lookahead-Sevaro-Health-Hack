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

### Contrast test results

Computed from `apps/web/src/ui/tokens.ts` by the same `contrast()` the test uses (WCAG 2.x; AA body text needs 4.5). Critical text is not used on the raised surface (4.42 at Night), so the test does not require it there.

| Text token | Surface | Night | Day |
|---|---|---:|---:|
| text | bg | 15.94 | 16.14 |
| text | panel | 14.60 | 17.48 |
| text | raised | 12.77 | 15.00 |
| muted | bg | 7.31 | 7.00 |
| muted | panel | 6.69 | 7.58 |
| muted | raised | 5.85 | 6.50 |
| ink3 | bg | 5.91 | 5.25 |
| ink3 | panel | 5.42 | 5.68 |
| accent | bg | 7.16 | 5.37 |
| accent | panel | 6.56 | 5.81 |
| critical | bg | 5.52 | 5.96 |
| critical | panel | 5.05 | 6.45 |
| warning | bg | 9.12 | 5.85 |
| warning | panel | 8.36 | 6.33 |
| ok | bg | 7.33 | 5.41 |
| ok | panel | 6.72 | 5.85 |
| info | bg | 7.71 | 7.09 |
| info | panel | 7.06 | 7.68 |

## Kit (`apps/web/src/ui/`)

`kit.tsx`: Button (primary, secondary, destructive, ghost; phone size with 48 px targets), Chip (semantic and ID), PriorityGlyph, StatusPill, SectionTitle, Rule, KitPanel, AnalogBar (value against the p90 normal band; caution or alarm only when abnormal), Pips (filled = available, hollow = required but missing), Sparkline, EmptyState, ErrorState, LoadingRules, Modal. `HorizonLine.tsx`: the signature element. `/design` renders every component in every state, in Night and Day, on live engine data; it is the screenshot target.

## The Horizon Line

One axis from now − 30 to now + 180 minutes. The past is faint, "now" is a fixed edge at about 14 % from the left, and the future axis is the only teal line on screen. Markers come from the engine's horizon timeline (D-95): shift ends as brackets labelled with a computed "−N physicians", confirmed and expected arrivals as solid and dashed brackets, forecast surge windows as hatched bands whose opacity is P(spike), projected gaps as a red segment under the line, offer and standby expiries as hourglasses, recommended action deadlines as teal flags with the engine's sentence. Labels sit on two lanes above and two below and are placed greedily so they never overlap (`test/horizonLine.test.ts`); a label that cannot be placed stays in the marker's tooltip and the SVG's text summary.

## Plan and self-review

Order of work (each step ends green and pushed):

1. Tokens, Day theme, contrast test, kit, `/design`.
2. App shell: the Horizon Line across the top of the command center, the patient clock band, the status line, and the detail column.
3. Pages through the kit: `/opener`, `/rewind`, the phone pages and `/lead`, then `/architecture`, the Stress Test panel, `/simulator`, `/quality`.
4. Command palette, shortcuts sheet, density toggle, embed theming.

Self-review against common failure modes of generated interfaces:

- Decorative color, gradients and glow: none; color appears only where a token's meaning applies.
- Centered hero layouts and oversized empty space: the opener is left-aligned; the console keeps its dense three-column grid.
- Placeholder numbers and lorem text: impossible by construction; components take engine DTOs, and `/design` uses the live view.
- Labels colliding on charts: the Horizon Line's lane placement is tested.
- Ambiguous status: every status has a shape and a word.


## What changed, page by page (UI pass, 2026-10-11)

- **All pages**: the patient-clock band (alarm at 14 % with a 2 px top rule, brain glyph, 28 px elapsed time on the sim clock, chips, neuron estimate linked to sources; a 24 px neutral "all assigned" band that collapses after 10 s), the "AI narrates. Humans decide." line, and a bottom status line in place of the floating pill (its modal kept). Theme script before paint (Night default, phones follow `prefers-color-scheme`, `?theme=` for embeds, T remembers), D density, ⌘K palette, ? shortcut sheet, skip link, 2 px focus outline.
- **`/` console**: the Horizon Line across the top (hover cross-highlights, click opens the detail column, overdue deadlines labelled); queue items with a priority rule and glyph, why line, ID chips and the engine's recommended action with one-click Propose; standby cards with initials, shape + word status (activation recommended included); analog bar (trailing 60 vs p90) in radar rows; coverage pips; a compact top bar whose navigation scrolls instead of clipping; a single-column layout below 1024 px; focusable scroll regions; an assertive live region for P1 only. Outline chips replace tinted fills that failed AA.
- **`/opener`**: left-aligned, 44 / 28 px sentences, teal Lookahead marks on the timeline, the impact line in tabular numerals, the citation in ink-3, "Open the command center".
- **`/rewind`**: the legend moved out of the SVG into HTML (labels had collided), clinical impact panel at the top.
- **Phones (`/offer`, `/standby`, `/lead`)**: 390 px column, 48 px+ targets, teal full-width primary, outline secondary, the window in 20 px tabular numerals, the expiry countdown, and a quiet "No case information is included." line (the word "patient" is on the PHI denylist for physician-facing text, so the brief's own wording is used instead). `/lead` asks for confirmation with the exact message before anything is sent; A opens the first confirmation.
- **`/architecture`**: the diagram is capped at 1100 px so its labels stay legible.
- **`/integrity`, `/quality`, `/state`**: mismatch cells and scroll regions fixed for axe.

## Verification

- `apps/web/e2e/ui.spec.ts`: axe-core (WCAG 2 A/AA) finds no serious or critical violation on `/`, `/opener`, `/rewind`, `/lead` and `/standby/[id]`; T toggles Night/Day and survives a reload; J/K move the next-best-action selection; ? and ⌘K work; a clock move updates the Horizon Line without a reload; no horizontal scroll at 1280×800 or 390×844 on `/`, `/opener`, `/rewind`, `/architecture`, `/design`.
- `apps/web/e2e/ui-screens.spec.ts` captures `/`, `/opener`, `/rewind`, `/lead`, `/standby/[id]`, `/architecture` and `/design` at 1440×900, 1280×800 and 390×844 in Night and Day into `docs/screens/ui/` (42 files). Each was reviewed; the fixes above came from that review.

## Known visual gaps

- The coverage grid shows about two hospital rows at 1440×900 under the Horizon Line; it scrolls, and the 1920×1080 projector layout shows them all.
- There is no per-row 120-min forecast strip in the coverage grid (the radar row carries the forecast). Local time (hospitals.csv `local_timezone`) shows in coverage rows and the detail column for hospitals outside ET; ET stays the primary clock everywhere.
- No audit stream pane on the console (the OFFERS tab and `/audit` carry the log); print pages and the presenter page were not built.
