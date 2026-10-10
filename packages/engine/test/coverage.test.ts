import { describe, expect, it } from 'vitest';
import { detect, type CoverageGap, type CoveragePoint } from '../src';
import { clock, dataset, report1820 } from './detect.helpers';
import { et } from './helpers';

const cov = report1820().coverage;
const at = (timeline: readonly CoveragePoint[], hms: string, h: string) => timeline.find((p) => p.tMs === et(hms))?.perHospital[h];
const gapRow = (g: CoverageGap) => [g.hospitalId, clock(g.startMs), g.endMs === 'beyond_horizon' ? 'beyond_horizon' : clock(g.endMs), g.required, g.staffed, [...g.whoRemains]];

describe('brief "What Teams Must Demonstrate" #4: project coverage forward at least 90 minutes (staffed capacity, OQ-24(a))', () => {
  it('horizon is >= 90 min (default 120) and a shorter horizon is refused', () => {
    expect(cov.horizonEndMs - cov.nowMs).toBe(120 * 60_000);
    expect(cov.timeline.at(-1)?.tMs).toBe(cov.horizonEndMs);
    expect(() => detect(dataset, et('18:20:00'), { horizonMin: 60 })).toThrow(RangeError);
  });

  it('exact boundaries are on the timeline: 19:00 (PHY-003/006 shift end, PHY-011 arrival) and 20:00 (four shift ends, PHY-012 arrival)', () => {
    const times = cov.timeline.map((p) => clock(p.tMs));
    expect(times).toContain('19:00:00');
    expect(times).toContain('20:00:00');
  });

  it('numbers at 19:00: SYN-005 needs 2 (block 1 + spike); SYN-010 needs 1', () => {
    // With arrivals: PHY-011's scheduled 19:00 night shift (credentialed at SYN-005) replaces PHY-003 and PHY-006 -> 2/2, no gap.
    expect(at(cov.timeline, '19:00:00', 'SYN-005')).toMatchObject({ blockMinimum: 1, spikeAdd: 1, required: 2, staffed: 2, staffedIds: ['PHY-005', 'PHY-011'], scheduledArrivalIds: ['PHY-011'] });
    // Without arrivals: only PHY-005 remains -> 1/2, gap from 19:00.
    expect(at(cov.timelineExcludingArrivals, '19:00:00', 'SYN-005')).toMatchObject({ required: 2, staffed: 1, staffedIds: ['PHY-005'] });
    // SYN-010: PHY-002 counts (busy on video still counts, OQ-02); PHY-008 is Temporarily Unavailable (held, OQ-28).
    for (const tl of [cov.timeline, cov.timelineExcludingArrivals]) {
      expect(at(tl, '19:00:00', 'SYN-010')).toMatchObject({ required: 1, staffed: 1, staffedIds: ['PHY-002'], tempUnavailableIds: ['PHY-008'] });
    }
    // At 20:00 PHY-002 leaves; PHY-012's scheduled night shift keeps SYN-010 at 1/1, without it 0/1.
    expect(at(cov.timeline, '20:00:00', 'SYN-010')).toMatchObject({ required: 1, staffed: 1, staffedIds: ['PHY-012'] });
    expect(at(cov.timelineExcludingArrivals, '20:00:00', 'SYN-010')).toMatchObject({ required: 1, staffed: 0 });
  });

  it('default (with scheduled arrivals): PHY-011 closes the 19:00 SYN-005 gap; gaps remain at SYN-005 and SYN-008 from 20:00', () => {
    // PHY-011's 19:00 arrival closes SYN-005 for 19:00-20:00. At 20:00 PHY-005 leaves and, with the spike held
    // (OQ-19), SYN-005 needs 2 but has only PHY-011. SYN-008 (tier A, needs 2) loses PHY-001/002/005 at 20:00.
    expect(cov.gaps.map(gapRow)).toEqual([
      ['SYN-005', '20:00:00', 'beyond_horizon', 2, 1, ['PHY-011']],
      ['SYN-008', '20:00:00', 'beyond_horizon', 2, 1, ['PHY-011']],
    ]);
    expect(cov.gaps[0]?.causes.map((c) => [c.kind, c.physicianId ?? null])).toEqual([
      ['shift_end', 'PHY-005'],
      ['spike', null],
    ]);
  });

  it('variant without scheduled arrivals: SYN-005 from 19:00, then six more hospitals at 20:00', () => {
    expect(cov.gapsExcludingArrivals.map(gapRow)).toEqual([
      ['SYN-005', '19:00:00', 'beyond_horizon', 2, 1, ['PHY-005']],
      ['SYN-001', '20:00:00', 'beyond_horizon', 2, 1, ['PHY-004']],
      ['SYN-003', '20:00:00', 'beyond_horizon', 2, 1, ['PHY-004']],
      ['SYN-004', '20:00:00', 'beyond_horizon', 1, 0, []],
      ['SYN-008', '20:00:00', 'beyond_horizon', 2, 0, []],
      ['SYN-010', '20:00:00', 'beyond_horizon', 1, 0, []],
      ['SYN-011', '20:00:00', 'beyond_horizon', 1, 0, []],
    ]);
    expect(cov.gapsExcludingArrivals[0]?.causes.map((c) => [c.kind, c.physicianId ?? null])).toEqual([
      ['shift_end', 'PHY-003'],
      ['shift_end', 'PHY-006'],
      ['spike', null],
    ]);
  });

  it('no gap now: at 18:20 every hospital meets its requirement', () => {
    const now = cov.timeline[0]!;
    for (const [h, x] of Object.entries(now.perHospital)) expect(x.staffed, h).toBeGreaterThanOrEqual(x.required);
  });

  it('routable-now counts are separate from staffed capacity: only PHY-004 is routable at 18:20', () => {
    expect(cov.routableNowIds).toEqual({
      'SYN-001': ['PHY-004'], 'SYN-002': [], 'SYN-003': ['PHY-004'], 'SYN-004': [], 'SYN-005': [], 'SYN-006': ['PHY-004'],
      'SYN-007': ['PHY-004'], 'SYN-008': [], 'SYN-009': ['PHY-004'], 'SYN-010': [], 'SYN-011': [], 'SYN-012': [],
    });
  });
});
