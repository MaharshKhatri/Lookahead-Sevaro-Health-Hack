'use client';

import { useEffect, useRef, useState } from 'react';
import type { ViewDTO } from '@/lib/dto';

/**
 * Change highlights (Phase 7): compares each new ViewDTO with the previous one
 * (kept in a ref) and reports the numbers that moved, for about 6 s. Tracked:
 * demand chip counts, the attention count, P(spike)@60 per hospital and the
 * standby EUM totals. Pure presentation: every number is engine output; this
 * only subtracts the previous value.
 */

export interface Delta {
  readonly key: string;
  readonly delta: number;
  /** Sim-clock instant of the view that introduced the change. */
  readonly atMs: number;
  readonly expiresAt: number;
}

export const DELTA_TTL_MS = 6_000;

function metrics(v: ViewDTO): Map<string, number> {
  const m = new Map<string, number>();
  m.set('attention', v.attention.length);
  for (const r of v.coverage.rows) m.set(`demand:${r.hospitalId}`, 0);
  for (const d of v.demand) m.set(`demand:${d.hospitalId}`, d.count);
  for (const h of v.forecast.hospitals) {
    m.set(`pspike60:${h.hospitalId}`, h.checkpoints.find((c) => c.minutesAhead === 60)?.pSpike ?? 0);
    m.set(`observed:${h.hospitalId}`, h.observedLast60);
  }
  m.set('eum:weighted', v.standby.plan.totals.totalWeightedEUM);
  m.set('eum:avoided', v.standby.plan.totals.expectedEUMAvoided);
  m.set('eum:residual', v.standby.plan.totals.residualEUM);
  return m;
}

export function useDeltas(view: ViewDTO | null, ttlMs = DELTA_TTL_MS): ReadonlyMap<string, Delta> {
  const prev = useRef<ViewDTO | null>(null);
  const [deltas, setDeltas] = useState<ReadonlyMap<string, Delta>>(new Map());
  useEffect(() => {
    const p = prev.current;
    prev.current = view;
    if (view === null || p === null || p.version === view.version) return;
    const now = Date.now();
    const cur = metrics(view);
    const before = metrics(p);
    const found: Delta[] = [];
    for (const [k, v] of cur) {
      const pv = before.get(k);
      if (pv !== undefined && Math.abs(v - pv) > 1e-9) found.push({ key: k, delta: Math.round((v - pv) * 1000) / 1000, atMs: view.clock.nowMs, expiresAt: now + ttlMs });
    }
    if (found.length === 0) return;
    setDeltas((m) => new Map([...[...m].filter(([, d]) => d.expiresAt > now), ...found.map((d): [string, Delta] => [d.key, d])]));
    const t = setTimeout(() => setDeltas((m) => new Map([...m].filter(([, d]) => d.expiresAt > Date.now()))), ttlMs + 50);
    return () => clearTimeout(t);
  }, [view, ttlMs]);
  return deltas;
}

export const fmtDelta = (d: number, digits = 0): string => `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}`;
