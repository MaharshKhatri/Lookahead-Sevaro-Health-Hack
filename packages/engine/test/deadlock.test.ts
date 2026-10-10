import { describe, expect, it } from 'vitest';
import { blockingExclusions } from '../src';
import { report1820 } from './detect.helpers';

const r = report1820();

describe('ROUTING_DEADLOCK: routing rule 5 ("If nobody is eligible, the routing attempt fails") at 18:20', () => {
  it('CON-2105 at SYN-010 and CON-2114 at SYN-005 are deadlocked; CON-2109 is not (its own call is ringing to PHY-007)', () => {
    expect(r.deadlocks.map((d) => [d.consultId, d.hospitalId])).toEqual([
      ['CON-2105', 'SYN-010'],
      ['CON-2114', 'SYN-005'],
    ]);
  });

  it('routable-now count is 0 at both hospitals (OQ-24(b))', () => {
    expect(r.coverage.routableNow['SYN-010']).toBe(0);
    expect(r.coverage.routableNow['SYN-005']).toBe(0);
  });

  it('gives a reason per credentialed on-shift physician', () => {
    const reasons = (id: string) =>
      Object.fromEntries(blockingExclusions(r.deadlocks.find((d) => d.consultId === id)!.choice).map((x) => [x.physicianId, x.failedRules.map((f) => f.detail)]));
    expect(reasons('CON-2105')).toEqual({
      'PHY-002': ['on Synapse video for CON-2101 since 18:06:00'],
      'PHY-008': ['self-reported status Temporarily Unavailable', 'inferred from data (OQ-23): CON-2110 assigned, hospital has not reached the physician yet'],
    });
    expect(reasons('CON-2114')).toEqual({
      'PHY-003': ['on outgoing call for CON-2102 since 18:16:20'],
      'PHY-005': ['on incoming call for CON-2104 since 18:14:00'],
      'PHY-006': ['on Synapse video for CON-2107 since 18:11:20'],
    });
  });

  it('deadlocks are the top attention items, with failure events as evidence', () => {
    expect(r.attention.slice(0, 2).map((a) => [a.kind, a.consultIds[0]])).toEqual([
      ['ROUTING_DEADLOCK', 'CON-2105'],
      ['ROUTING_DEADLOCK', 'CON-2114'],
    ]);
    expect(r.attention[0]?.because.map((b) => b.eventId)).toEqual(expect.arrayContaining(['EVT-01144', 'EVT-01155', 'EVT-01162']));
  });
});
