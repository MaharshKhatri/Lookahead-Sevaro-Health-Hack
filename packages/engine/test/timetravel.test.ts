import { describe, expect, it } from 'vitest';
import { detect } from '../src';
import { dataset } from './detect.helpers';
import { et } from './helpers';

describe('detect at later instants with known events only (brief Detect layer: "now and ... the next 60-90 minutes")', () => {
  for (const hms of ['19:00:00', '19:30:00']) {
    it(`at ${hms}: PHY-003/006 off shift, PHY-011's scheduled arrival appears, output stable and sane`, () => {
      const r = detect(dataset, et(hms));
      for (const id of ['PHY-003', 'PHY-006']) {
        expect(r.routability['SYN-005']?.[id]?.reasons.find((x) => x.rule === 'ROUTE_ON_SHIFT')?.pass, id).toBe(false);
        expect(r.coverage.timeline[0]?.perHospital['SYN-005']?.staffedIds, id).not.toContain(id);
      }
      // Scheduled night shift 19:00 (OQ-27): counted as staffed and routable, but unverified (no presence signals yet).
      expect(r.coverage.timeline[0]?.perHospital['SYN-005']).toMatchObject({ staffedIds: ['PHY-005', 'PHY-011'], scheduledArrivalIds: ['PHY-011'] });
      expect(r.routability['SYN-005']?.['PHY-011']).toMatchObject({ routable: true, verified: false });
      // Sane: deterministic, clocks run forward, nothing negative, every item explained.
      expect(detect(dataset, et(hms))).toEqual(r);
      for (const s of r.standards) expect(s.elapsedMs, s.consultId).toBeGreaterThanOrEqual(0);
      for (const a of r.attention) expect(a.why.length > 0 && a.because.length > 0, a.id).toBe(true);
    });
  }

  it('state is frozen after the last event, so breaches only escalate (19:30 vs 18:20)', () => {
    const level = (hms: string, id: string) => detect(dataset, et(hms)).standards.find((s) => s.consultId === id)?.level;
    expect(level('18:20:00', 'CON-2113')).toBe('ok');
    expect(level('19:30:00', 'CON-2113')).toBe('critical');
  });

  it('the SYN-005 spike ages out of the trailing window by 19:30 (OQ-19), so its requirement drops back to 1', () => {
    expect(detect(dataset, et('19:00:00')).demand.find((d) => d.hospitalId === 'SYN-005')).toMatchObject({ count: 2, spike: true });
    expect(detect(dataset, et('19:30:00')).demand.find((d) => d.hospitalId === 'SYN-005')).toMatchObject({ count: 0, spike: false });
  });
});
