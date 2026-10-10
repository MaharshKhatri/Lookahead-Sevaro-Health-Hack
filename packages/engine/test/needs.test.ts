import { describe, expect, it } from 'vitest';
import { decide } from '../src';
import { clock, dataset, decision1820, end, needRow } from './decide.helpers';
import { et } from './helpers';

const r = decision1820();

describe('Needs at 18:20 (brief "Problem to Solve" Detect -> Decide; OQ-29..OQ-33)', () => {
  it('table: two DEADLOCK_NOW (routing rule 5), two HARD_GAP and six AT_RISK starting within the 120-min detection horizon', () => {
    expect(r.needs.map(needRow)).toEqual([
      ['DEADLOCK_NOW', 'SYN-005', '18:20:00', '19:00:00', null, null, null],
      ['DEADLOCK_NOW', 'SYN-010', '18:20:00', '20:00:00', null, null, null],
      ['AT_RISK', 'SYN-005', '19:00:00', '20:00:00', 2, 1, 1],
      ['HARD_GAP', 'SYN-005', '20:00:00', 'beyond_horizon', 2, 0, 1],
      ['HARD_GAP', 'SYN-008', '20:00:00', '22:00:00', 2, 0, 1],
      ['AT_RISK', 'SYN-001', '20:00:00', '21:00:00', 2, 1, 1],
      ['AT_RISK', 'SYN-003', '20:00:00', '21:00:00', 2, 1, 1],
      ['AT_RISK', 'SYN-004', '20:00:00', 'beyond_horizon', 1, 0, 1],
      ['AT_RISK', 'SYN-010', '20:00:00', 'beyond_horizon', 1, 0, 1],
      ['AT_RISK', 'SYN-011', '20:00:00', 'beyond_horizon', 1, 0, 1],
    ]);
    for (const n of r.needs) expect(n.startMs).toBeLessThanOrEqual(et('20:20:00'));
  });

  it('OQ-32: DEADLOCK_NOW ends at the first known relief: SYN-005 at 19:00 (PHY-011), SYN-010 at 20:00 (PHY-012)', () => {
    const [d5, d10] = r.needs.filter((n) => n.kind === 'DEADLOCK_NOW');
    expect(d5).toMatchObject({ hospitalId: 'SYN-005', consultIds: ['CON-2114'], severity: 'critical', strokeAtRisk: true });
    expect(d5?.why[1]).toMatch(/Relief expected at 19:00 ET: PHY-011 \(scheduled arrival, expected\)/);
    expect(d10).toMatchObject({ hospitalId: 'SYN-010', consultIds: ['CON-2105'], severity: 'critical', strokeAtRisk: true });
    expect(d10?.why[1]).toMatch(/Relief expected at 20:00 ET: PHY-012/);
    expect(d10?.because.length).toBeGreaterThan(0);
  });

  it('OQ-32: with no known relief the DEADLOCK_NOW window is DEADLOCK_DEFAULT_WINDOW_MIN (60) from now', () => {
    const noArrivals = { ...dataset, offShiftRoster: dataset.offShiftRoster.filter((p) => p.physicianId !== 'PHY-012') };
    const d10 = decide(noArrivals, et('18:20:00')).needs.find((n) => n.kind === 'DEADLOCK_NOW' && n.hospitalId === 'SYN-010');
    expect(d10 && end(d10)).toBe('19:20:00');
    expect(d10?.why[1]).toMatch(/window set to 60 min \(OQ-32\)/);
  });

  it('OQ-30: only DEADLOCK_NOW and HARD_GAP qualify a hospital for offers; AT_RISK is advisory', () => {
    for (const n of r.needs) expect(n.qualifiesForOffers, n.kind).toBe(n.kind !== 'AT_RISK');
    expect(r.gapHospitals.filter((g) => g.qualifiesForOffers).map((g) => g.hospitalId)).toEqual(['SYN-005', 'SYN-008', 'SYN-010']);
    expect(r.gapHospitals.filter((g) => !g.qualifiesForOffers).map((g) => g.hospitalId)).toEqual(['SYN-001', 'SYN-003', 'SYN-004', 'SYN-011']);
    for (const n of r.needs.filter((x) => x.kind === 'AT_RISK')) expect(n.why.at(-1)).toMatch(/does not justify a split-shift offer \(OQ-30\)/);
  });

  it('severity follows NEED_KIND_SEVERITY; every need explains itself and cites a rule', () => {
    const sev = Object.fromEntries(r.needs.map((n) => [n.kind, n.severity]));
    expect(sev).toEqual({ DEADLOCK_NOW: 'critical', HARD_GAP: 'high', AT_RISK: 'medium' });
    for (const n of r.needs) {
      expect(n.why.length).toBeGreaterThan(0);
      expect(n.rule).toMatch(/^NEED_/);
    }
  });

  it('HARD_GAP causes come from the coverage projection (shift ends, spike)', () => {
    const g5 = r.needs.find((n) => n.kind === 'HARD_GAP' && n.hospitalId === 'SYN-005');
    expect(g5?.why.slice(1)).toEqual(['Cause: PHY-005 shift ends 20:00 ET.', 'Cause: demand spike adds +1: 5 consults in 60 min vs p90 1.']);
    expect(g5?.attentionItemIds.length).toBe(1);
  });

  it('ids are unique and stable across runs', () => {
    const ids = r.needs.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(decide(dataset, et('18:20:00')).needs.map((n) => n.id)).toEqual(ids);
    expect(clock(r.nowMs)).toBe('18:20:00');
  });
});
