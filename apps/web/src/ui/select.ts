'use client';

/**
 * Cross-highlight and selection bus (UI pass). Any pane can highlight the
 * elements related to a hospital or physician (hover) and select an item for
 * the detail column (click). Elements opt in with data-hospital-id,
 * data-hospital-ids (space-separated), data-physician-id or
 * data-physician-ids. Pure DOM: no pane needs to know the others.
 */

export interface Selection {
  readonly kind: 'marker' | 'hospital' | 'physician' | 'attention' | 'incident';
  readonly title: string;
  readonly whenMs: number | null;
  readonly endMs: number | null;
  readonly detail: string;
  readonly hospitalIds: readonly string[];
  readonly physicianIds: readonly string[];
}

const HL = 'hl-related';

function related(hospitalIds: readonly string[], physicianIds: readonly string[]): HTMLElement[] {
  const sel = [
    ...hospitalIds.flatMap((h) => [`[data-hospital-id="${CSS.escape(h)}"]`, `[data-hospital-ids~="${CSS.escape(h)}"]`]),
    ...physicianIds.flatMap((p) => [`[data-physician-id="${CSS.escape(p)}"]`, `[data-physician-ids~="${CSS.escape(p)}"]`]),
  ].join(', ');
  return sel === '' ? [] : [...document.querySelectorAll<HTMLElement>(sel)];
}

export function highlight(hospitalIds: readonly string[], physicianIds: readonly string[]): void {
  clearHighlight();
  for (const el of related(hospitalIds, physicianIds)) el.classList.add(HL);
}

export function clearHighlight(): void {
  for (const el of document.querySelectorAll<HTMLElement>(`.${HL}`)) el.classList.remove(HL);
}

export function select(s: Selection | null): void {
  window.dispatchEvent(new CustomEvent<Selection | null>('lookahead:select', { detail: s }));
}
