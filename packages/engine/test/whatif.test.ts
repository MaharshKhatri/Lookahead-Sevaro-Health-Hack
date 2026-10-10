import { describe, expect, it } from 'vitest';
import { projectWithOffers, type NeedChange } from '../src';
import { clock, dataset, decision1820, needRow } from './decide.helpers';
import { et } from './helpers';

const r = decision1820();
const change = (kind: string, h: string, hms: string) => r.whatIf.changes.find((c) => c.before.kind === kind && c.before.hospitalId === h && c.before.startMs === et(hms)) as NeedChange;

describe('What-if: accept the recommended offer (brief "What Teams Must Demonstrate" #4-#5; OQ-24(b), OQ-31)', () => {
  it('the what-if uses the recommended offer: PHY-009 18:35-22:35, scope SYN-005/008/010, seed 14', () => {
    expect(r.whatIf.offers).toEqual([
      { physicianId: 'PHY-009', name: 'Dr. Grace Okafor', startMs: et('18:35:00'), endMs: et('22:35:00'), scopeHospitalIds: ['SYN-005', 'SYN-008', 'SYN-010'], seededConsultCount: 14 },
    ]);
  });

  it('SYN-010 (deadlocked on CON-2105) has >= 1 routable physician from the offer start', () => {
    const at10 = r.whatIf.after?.routableAtOfferStart.find((x) => x.hospitalId === 'SYN-010');
    expect(at10).toMatchObject({ atMs: et('18:35:00'), count: 1, ids: ['PHY-009'] });
    expect(r.detection.coverage.routableNow['SYN-010']).toBe(0);
  });

  it('both deadlocks shrink to 18:20-18:35 (time to come online)', () => {
    expect(change('DEADLOCK_NOW', 'SYN-005', '18:20:00')).toMatchObject({ outcome: 'shortened', detail: 'DEADLOCK_NOW remains for 15 of 40 min; now DEADLOCK_NOW 18:20-18:35' });
    expect(change('DEADLOCK_NOW', 'SYN-010', '18:20:00')).toMatchObject({ outcome: 'shortened', detail: 'DEADLOCK_NOW remains for 15 of 100 min; now DEADLOCK_NOW 18:20-18:35' });
  });

  it('HARD_GAP SYN-008 20:00-22:00 is downgraded to AT_RISK (the offer is expected until shift_started, OQ-29)', () => {
    expect(change('HARD_GAP', 'SYN-008', '20:00:00')).toMatchObject({ outcome: 'downgraded', detail: 'now AT_RISK 20:00-22:00' });
  });

  it('HARD_GAP SYN-005 is only shortened: it reopens at 22:35 when the 4-h offer ends (not hidden by the detection horizon)', () => {
    expect(change('HARD_GAP', 'SYN-005', '20:00:00')).toMatchObject({ outcome: 'shortened', detail: 'HARD_GAP remains for 45 of 200 min; now AT_RISK 20:00-22:35, HARD_GAP 22:35-beyond' });
    expect(r.whatIf.after?.needs.map(needRow)).toContainEqual(['HARD_GAP', 'SYN-005', '22:35:00', 'beyond_horizon', 2, 0, 1]);
  });

  it('AT_RISK SYN-005 19:00-20:00 closes (3 staffed vs 2 required: margin > 0); out-of-scope SYN-004 is unchanged', () => {
    expect(change('AT_RISK', 'SYN-005', '19:00:00').outcome).toBe('closed');
    expect(change('AT_RISK', 'SYN-004', '20:00:00').outcome).toBe('unchanged');
    expect(r.whatIf.introduced).toEqual([]);
  });

  it('before and after cover the same decision projection; with no offers after == before', () => {
    const none = projectWithOffers(dataset, et('18:20:00'), []);
    expect(none.needs.map(needRow)).toEqual(r.whatIf.before.map(needRow));
    expect(none.routableAtOfferStart).toEqual([]);
    expect(clock(none.coverage.horizonEndMs)).toBe('23:20:00');
    // Top-level needs are the subset starting within the 120-min detection horizon.
    expect(r.whatIf.before.filter((n) => n.startMs <= et('20:20:00')).map(needRow)).toEqual(r.needs.map(needRow));
  });

  it('pure: projecting an offer does not mutate the dataset or the base detection', () => {
    const events = dataset.events.length;
    const shifts = r.detection.staffing.shifts.length;
    projectWithOffers(dataset, et('18:20:00'), r.whatIf.offers);
    expect([dataset.events.length, r.detection.staffing.shifts.length]).toEqual([events, shifts]);
  });
});
