'use client';

import { etHm } from '@/lib/format';
import { fmtDelta, type Delta } from './useDelta';

/** "+1 · at 18:21": a changed number's delta, shown for ~6 s (useDeltas). */
export function DeltaChip({ d, digits = 0, unit = '' }: { readonly d: Delta | undefined; readonly digits?: number; readonly unit?: string }) {
  if (d === undefined) return null;
  const up = d.delta > 0;
  return (
    <span
      data-testid="delta-chip"
      data-key={d.key}
      role="status"
      className={`num inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-none ${up ? 'border-warning/60 bg-warning/15 text-warning' : 'border-info/60 bg-info/15 text-info'}`}
      title={`changed by ${fmtDelta(d.delta, digits)}${unit} in the view at ${etHm(d.atMs)} ET`}
    >
      {fmtDelta(d.delta, digits)}
      {unit} · at {etHm(d.atMs)}
    </span>
  );
}
