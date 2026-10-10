import { describe, expect, it } from 'vitest';
import { blockingExclusions, buildStaffingModel, chooseRoute, replay, routableNow, type NetworkState, type PhysicianState } from '../src';
import { dataset } from './detect.helpers';
import { et } from './helpers';

const failures = dataset.events.filter((e) => e.eventType === 'routing_attempt_failed');

describe('brief "How Calls Reach Physicians" rule 5 + OQ-23: every routing_attempt_failed is reproduced', () => {
  // Expected blockers, read off the event stream (physician: failing rule-2 checks).
  const expected: Record<string, Record<string, string[]>> = {
    'EVT-01144': { 'PHY-002': ['ROUTE_NOT_ON_VIDEO'], 'PHY-008': ['ROUTE_NO_PENDING_FIRST_CONTACT'] },
    'EVT-01155': { 'PHY-002': ['ROUTE_NOT_ON_VIDEO'], 'PHY-008': ['ROUTE_NOT_TEMP_UNAVAILABLE', 'ROUTE_NO_PENDING_FIRST_CONTACT'] },
    'EVT-01160': { 'PHY-003': ['ROUTE_NOT_ON_CALL'], 'PHY-005': ['ROUTE_NOT_ON_CALL'], 'PHY-006': ['ROUTE_NOT_EXTERNAL_VIDEO'] },
    'EVT-01162': { 'PHY-002': ['ROUTE_NOT_ON_VIDEO'], 'PHY-008': ['ROUTE_NOT_TEMP_UNAVAILABLE', 'ROUTE_NO_PENDING_FIRST_CONTACT'] },
  };

  it('the stream has 4 routing failures', () => expect(failures.map((e) => e.eventId)).toEqual(Object.keys(expected)));

  for (const e of failures) {
    it(`${e.eventId} at ${e.eventTimeRaw.slice(11, 19)} (${e.hospitalId}): chooseRoute returns null with the expected blockers`, () => {
      const state = replay(dataset, e.eventTime);
      const choice = chooseRoute(state, buildStaffingModel(dataset, state), e.hospitalId ?? '', e.eventTime, { forConsultId: e.consultId ?? '' });
      const blockers = Object.fromEntries(blockingExclusions(choice).map((x) => [x.physicianId, x.failedRules.map((r) => r.rule)]));
      console.log(`${e.eventId} ${e.hospitalId}: ${blockingExclusions(choice).map((x) => `${x.physicianId} [${x.failedRules.map((r) => r.detail).join('; ')}]`).join(' | ')}`);
      expect(choice.chosen).toBeNull();
      expect(choice.rule).toBe('ROUTE_NO_ONE_ELIGIBLE');
      expect(blockers).toEqual(expected[e.eventId]);
    });
  }
});

describe('historical assignment agreement (informational, not a gate; DECISIONS D-18: generator only loosely follows rule 2)', () => {
  it('computes, for every physician_assigned, whether chooseRoute at eventTime - 1 ms picks the same physician', () => {
    const assigned = dataset.events.filter((e) => e.eventType === 'physician_assigned');
    let agree = 0;
    let modelNull = 0;
    for (const e of assigned) {
      const t = e.eventTime - 1;
      const state = replay(dataset, t);
      const hospital = state.consults[e.consultId ?? '']?.hospitalId ?? e.hospitalId ?? '';
      const choice = chooseRoute(state, buildStaffingModel(dataset, state), hospital, t, { forConsultId: e.consultId ?? '' });
      if (choice.chosen === e.physicianId) agree++;
      if (choice.chosen === null) modelNull++;
    }
    console.log(`routing agreement: ${agree}/${assigned.length} assignments match chooseRoute (${modelNull} where the model finds nobody eligible)`);
    expect(assigned).toHaveLength(100);
  });
});

describe('routableNow: rules 1-2 per physician (OQ-24(b))', () => {
  const at = (hms: string) => {
    const s = replay(dataset, et(hms));
    return { s, st: buildStaffingModel(dataset, s), t: et(hms) };
  };
  const failed = (r: ReturnType<typeof routableNow>) => r.reasons.filter((x) => x.affects === 'routable' && !x.pass).map((x) => x.rule);

  it('documenting does not block routing (OQ-06): PHY-004 is routable at SYN-001 at 18:20', () => {
    const { s, st, t } = at('18:20:00');
    const r = routableNow(s, st, 'PHY-004', 'SYN-001', t);
    expect(r).toMatchObject({ routable: true, verified: true });
    expect(r.reasons.find((x) => x.rule === 'ROUTE_DOCUMENTING_ALLOWED')?.detail).toContain('CON-2108');
  });

  it('rule 2 "phone already ringing for another call": PHY-007 is blocked for other calls but routable for CON-2109 itself, unverified (agent offline)', () => {
    const { s, st, t } = at('18:20:00');
    expect(failed(routableNow(s, st, 'PHY-007', 'SYN-012', t))).toEqual(['ROUTE_PHONE_NOT_RINGING']);
    expect(routableNow(s, st, 'PHY-007', 'SYN-012', t, { forConsultId: 'CON-2109' })).toMatchObject({ routable: true, verified: false });
  });

  it('OQ-23 is labelled as inferred from data', () => {
    const { s, st, t } = at('18:20:00');
    const pending = routableNow(s, st, 'PHY-008', 'SYN-010', t).reasons.find((x) => x.rule === 'ROUTE_NO_PENDING_FIRST_CONTACT');
    expect(pending).toMatchObject({ pass: false, inferred: true });
    expect(pending?.detail).toMatch(/^inferred from data \(OQ-23\): CON-2110/);
  });

  it('rule 2 "ended a call less than 2 minutes ago": PHY-006 at 18:11:00 (call ended 18:10:40) is cooling down; at 18:12:41 it is not', () => {
    const early = at('18:11:00');
    expect(failed(routableNow(early.s, early.st, 'PHY-006', 'SYN-005', early.t))).toContain('ROUTE_CALL_COOLDOWN');
    const later = at('18:12:41');
    expect(failed(routableNow(later.s, later.st, 'PHY-006', 'SYN-005', later.t))).not.toContain('ROUTE_CALL_COOLDOWN');
  });

  it('OQ-07: a video end does not start the cooldown (PHY-005 at 18:12:30, video ended 18:11:50, last call ended 18:01:30)', () => {
    const { s, st, t } = at('18:12:30');
    expect(routableNow(s, st, 'PHY-005', 'SYN-005', t).reasons.find((x) => x.rule === 'ROUTE_CALL_COOLDOWN')?.pass).toBe(true);
  });

  it('rule 1: off shift after 19:00 (PHY-003), credentialing required', () => {
    const { s, st, t } = at('19:05:00');
    expect(failed(routableNow(s, st, 'PHY-003', 'SYN-001', t))).toContain('ROUTE_ON_SHIFT');
    const { s: s2, st: st2, t: t2 } = at('18:20:00');
    expect(failed(routableNow(s2, st2, 'PHY-004', 'SYN-010', t2))).toEqual(['ROUTE_CREDENTIALED']);
  });

  it('"Camera active with status In Meeting: available": In Meeting is reported as interruptible, never a block', () => {
    const { s, st, t } = at('13:15:00');
    const r = routableNow(s, st, 'PHY-004', 'SYN-001', t);
    expect(r.reasons.find((x) => x.rule === 'ROUTE_IN_MEETING_ALLOWED')).toMatchObject({ pass: true, affects: 'info' });
    expect(failed(r)).not.toContain('ROUTE_NOT_EXTERNAL_VIDEO');
  });
});

describe('chooseRoute ordering: rules 3-4 (OQ-10, OQ-26)', () => {
  // Synthetic: start from the 19:05 state and make every SYN-001 physician idle, then set volumes.
  const t = et('19:05:00');
  const base = replay(dataset, t);
  const idle = (p: PhysicianState, consults: number, lastAnsweredMs: number | null): PhysicianState => ({
    ...p,
    activeCalls: [],
    activeVideo: null,
    ringing: null,
    flags: [],
    openConsultIds: [],
    lastCallEndedMs: null,
    lastCallEndedBy: null,
    consultsThisShift: consults,
    lastAnsweredMs,
    selfStatus: { ...p.selfStatus, value: 'Available' },
  });
  const make = (vols: Record<string, [number, number | null]>): NetworkState => {
    const physicians = { ...base.physicians };
    for (const [id, [n, last]] of Object.entries(vols)) {
      const p = physicians[id] ?? { ...base.physicians['PHY-001']!, physicianId: id, onRoster: false, shift: null };
      physicians[id] = idle(p, n, last);
    }
    return { ...base, physicians };
  };
  const route = (vols: Record<string, [number, number | null]>) => {
    const s = make(vols);
    return chooseRoute(s, buildStaffingModel(dataset, s), 'SYN-001', t);
  };

  it('rule 4: fewest consults wins when nobody is low volume', () => {
    const c = route({ 'PHY-001': [12, et('18:00:00')], 'PHY-004': [9, et('18:10:00')], 'PHY-011': [13, et('19:01:00')] });
    expect(c.chosen).toBe('PHY-004');
    expect(c.ranked.map((x) => x.tier)).toEqual(['fewest_consults', 'fewest_consults', 'fewest_consults']);
  });

  it('rule 4 tie: whoever answered least recently; never-answered first', () => {
    expect(route({ 'PHY-001': [10, et('18:00:00')], 'PHY-004': [10, et('17:00:00')], 'PHY-011': [11, null] }).chosen).toBe('PHY-004');
    expect(route({ 'PHY-001': [10, et('18:00:00')], 'PHY-004': [10, null], 'PHY-011': [11, null] }).chosen).toBe('PHY-004');
  });

  it('rule 3: low volume is 6 or fewer on days but 4 or fewer on nights (PHY-011 starts 19:00, a night shift per OQ-10)', () => {
    const c = route({ 'PHY-001': [6, et('18:00:00')], 'PHY-004': [12, null], 'PHY-011': [5, null] });
    expect(c.chosen).toBe('PHY-001');
    expect(c.ranked.map((x) => [x.physicianId, x.tier])).toEqual([
      ['PHY-001', 'low_volume_priority'],
      ['PHY-011', 'fewest_consults'],
      ['PHY-004', 'fewest_consults'],
    ]);
  });
});
