import { describe, expect, it } from 'vitest';
import { analyzeTrap, medianFloor, routableNow, withShifts } from '../src';
import { decision1820 } from './decide.helpers';
import { et } from './helpers';

const r = decision1820();
const offer = r.recommendedOffer;
const trap = offer?.trap;
const firstPicks = (rows: readonly { hospitalId: string; firstPick: boolean }[]) => rows.filter((x) => x.firstPick).map((x) => x.hospitalId);

describe('brief "The split-shift trap" (OQ-35): PHY-009 joining at 18:35', () => {
  it('a joiner at 0 consults is first pick at every credentialed hospital (rules 3-4; night shift low volume <= 4, OQ-10)', () => {
    expect(trap).toMatchObject({ physicianId: 'PHY-009', source: 'split_shift_offer', advisory: false, startMs: et('18:35:00'), dayShift: false, lowVolumeLimit: 4 });
    expect(trap?.credentialedHospitalIds).toEqual(['SYN-004', 'SYN-005', 'SYN-008', 'SYN-010']);
    expect(trap?.before.every((x) => x.joinerConsults === 0 && x.joinerTier === 'low_volume_priority')).toBe(true);
    expect(firstPicks(trap?.before ?? [])).toEqual(['SYN-004', 'SYN-005', 'SYN-008', 'SYN-010']);
  });

  it('credentialedOutsideScope: SYN-004 Meadowlands (AT_RISK only, not a gap hospital) is outside the routing scope', () => {
    expect(trap?.scopeHospitalIds).toEqual(['SYN-005', 'SYN-008', 'SYN-010']);
    expect(trap?.credentialedOutsideScope).toEqual(['SYN-004']);
    expect(trap?.after.find((x) => x.hospitalId === 'SYN-004')).toMatchObject({ hospitalName: 'Meadowlands Community Hospital', inScope: false, firstPick: false });
  });

  it('SEED = median (floor) of on-shift peers at the scope hospitals: [10, 12, 14, 14, 15, 15] -> 14 > 4, so no low-volume priority', () => {
    expect(trap?.seedBasis.map((b) => [b.physicianId, b.consults])).toEqual([
      ['PHY-008', 10],
      ['PHY-001', 12],
      ['PHY-002', 14],
      ['PHY-003', 14],
      ['PHY-005', 15],
      ['PHY-006', 15],
    ]);
    expect(trap?.seededConsultCount).toBe(14);
    expect(trap?.after.every((x) => x.joinerTier === 'fewest_consults')).toBe(true);
  });

  it('with SCOPE + SEED (recommended) the joiner competes on equal terms: first pick only at SYN-005, nowhere outside scope', () => {
    expect(trap?.recommended).toBe('scope_and_seed');
    expect(firstPicks(trap?.after ?? [])).toEqual(['SYN-005']);
    expect(trap?.trapWhy).toHaveLength(4);
  });

  it('feeds the offer: routingScope = scope, seededConsultCount = seed', () => {
    expect(offer?.routingScope).toEqual(trap?.scopeHospitalIds);
    expect(offer?.seededConsultCount).toBe(14);
  });

  it('routing honours an accepted scoped offer: SYN-004 is "outside split-shift scope"; consults start at the seed', () => {
    if (offer === null || offer === undefined) throw new Error('no offer');
    const { state, staffing } = r.detection;
    const scoped = withShifts(staffing, [
      { physicianId: 'PHY-009', name: offer.name, startMs: offer.window.startMs, endMs: offer.window.endMs, source: 'split_shift_offer', dayShift: false, confirmation: 'expected', confirmedBy: null, scopeHospitalIds: offer.routingScope, seededConsults: 14 },
    ]);
    const t = et('18:40:00');
    const outside = routableNow(state, scoped, 'PHY-009', 'SYN-004', t);
    expect(outside.routable).toBe(false);
    expect(outside.reasons.find((x) => x.rule === 'ROUTE_CREDENTIALED')?.detail).toBe('credentialed at SYN-004 but outside split-shift scope (SYN-005, SYN-008, SYN-010)');
    expect(routableNow(state, scoped, 'PHY-009', 'SYN-010', t).routable).toBe(true);
  });

  it('scheduled arrivals get an advisory analysis (SEED only, scope is not ours): PHY-011 19:00 and PHY-012 20:00', () => {
    expect(r.arrivalTraps.map((a) => [a.physicianId, a.advisory, a.recommended, a.scopeHospitalIds, a.seededConsultCount])).toEqual([
      ['PHY-011', true, 'seed', null, 14],
      ['PHY-012', true, 'seed', null, 10],
    ]);
    expect(firstPicks(r.arrivalTraps[0]?.before ?? [])).toEqual(['SYN-001', 'SYN-004', 'SYN-005', 'SYN-008', 'SYN-009', 'SYN-011']);
  });

  it('a day-shift joiner uses the day low-volume limit (brief rule 3: "6 or fewer consults on days"; OQ-10)', () => {
    const day = analyzeTrap(r.detection, { physicianId: 'PHY-009', startMs: et('09:00:00'), scopeHospitalIds: null, source: 'scheduled_arrival' });
    expect([day.dayShift, day.lowVolumeLimit]).toEqual([true, 6]);
  });

  it('medianFloor: odd count -> middle; even -> floor of the two middle values; empty -> 0', () => {
    expect(medianFloor([15, 10, 12])).toBe(12);
    expect(medianFloor([10, 12, 14, 15])).toBe(13);
    expect(medianFloor([6, 13])).toBe(9);
    expect(medianFloor([])).toBe(0);
  });
});
