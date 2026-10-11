import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@lookahead/engine';
import { DATA_DIR } from './helpers';
import { buildCoordinatorIntel, forecast, planWithLog, replay, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import { placeLabels, toMarkers } from '@/ui/HorizonLine';

/**
 * Horizon Line layout (UI pass): point events at the same minute are grouped
 * ("-N physicians"), and labels on the same lane never overlap.
 */

const MIN = 60_000;
const item = (kind: TimelineItem['kind'], tMs: number, label: string, physicianId: string | null = null): TimelineItem => ({ kind, tMs, endMs: null, hospitalId: null, physicianId, label, detail: label, value: null });

describe('Horizon Line layout', () => {
  it('groups shift ends at the same minute into one bracket with a computed count', () => {
    const t = 1_000 * MIN;
    const m = toMarkers([item('now', 0, 'now'), item('shift_end', t, 'A ends', 'a'), item('shift_end', t + 20_000, 'B ends', 'b'), item('shift_end', t + 30 * MIN, 'C ends', 'c')]);
    const ends = m.filter((x) => x.kind === 'shift_end');
    expect(ends.map((x) => x.label)).toEqual(['−2 physicians', '−1 physician']);
    expect(ends[0]?.physicianIds).toEqual(['a', 'b']);
    expect(m.some((x) => x.kind === 'now')).toBe(false);
  });

  it('never overlaps labels on a lane (real 18:20 timeline and a dense synthetic one)', () => {
    const ds = loadDataset(DATA_DIR);
    const now = snapshotAsOfMs(ds) ?? 0;
    const { plan, decision } = planWithLog({ dataset: ds }, [], now);
    const fc = forecast(ds, replay(ds, now), now);
    const intel = buildCoordinatorIntel({ dataset: ds, decision, forecast: fc, plan, log: [], nowMs: now });
    const dense = Array.from({ length: 30 }, (_, i) => item('action_deadline', now + i * 2 * MIN, `deadline label number ${i}`));
    for (const items of [intel.timeline.items, dense]) {
      const x = (ms: number) => ((ms - now) / (180 * MIN)) * 1000;
      const placed = placeLabels(toMarkers(items), x);
      const byLane = new Map<number, { x: number; w: number }[]>();
      for (const p of placed) if (p.lane !== null) byLane.set(p.lane, [...(byLane.get(p.lane) ?? []), { x: p.x, w: p.m.label.length * 6.1 + 14 }]);
      for (const row of byLane.values()) for (let i = 1; i < row.length; i++) expect(row[i]!.x).toBeGreaterThanOrEqual(row[i - 1]!.x + row[i - 1]!.w);
      expect(placed.length).toBe(toMarkers(items).filter((m) => m.kind !== 'gap_band' && m.kind !== 'surge_band').length);
    }
  });
});
