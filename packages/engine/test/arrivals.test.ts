import { describe, expect, it } from 'vitest';
import { appendEventText, coverageStatus, detect, type HospitalCoverageAt } from '../src';
import { clock, dataset } from './detect.helpers';
import { et } from './helpers';

// Test-only rows in the event_stream.csv format (brief "Synthetic Dataset"); IDs are test fixtures.
const shiftStarted = (id: string, physicianId: string, hms: string, ingestHms: string) =>
  `${id},2026-03-17T${hms}-04:00,2026-03-17T${ingestHms}-04:00,,shift_started,${physicianId},,Shift started`;

const arrival = (r: ReturnType<typeof detect>, physicianId: string) => r.staffing.shifts.find((s) => s.source === 'scheduled_arrival' && s.physicianId === physicianId);
const interval = (r: ReturnType<typeof detect>, h: string, hms: string) => r.coverage.classification.find((c) => c.hospitalId === h && c.startMs <= et(hms) && (c.endMs === 'beyond_horizon' || et(hms) < c.endMs));

describe('OQ-29 arrival confirmation (brief "Availability is inferred" + "What Teams Must Demonstrate" #4)', () => {
  it('at 18:20 PHY-011 (scheduled 19:00) is EXPECTED: no shift_started known yet', () => {
    const r = detect(dataset, et('18:20:00'));
    expect(arrival(r, 'PHY-011')).toMatchObject({ startMs: et('19:00:00'), confirmation: 'expected', confirmedBy: null });
    expect(arrival(r, 'PHY-012')).toMatchObject({ startMs: et('20:00:00'), confirmation: 'expected', confirmedBy: null });
    // On-shift roster physicians are their own category, not "expected".
    expect(r.staffing.shifts.filter((s) => s.source === 'on_shift_roster').every((s) => s.confirmation === 'roster')).toBe(true);
  });

  it('every projection point and gap carries staffedConfirmed + staffedExpected = staffed', () => {
    const r = detect(dataset, et('18:20:00'));
    for (const p of r.coverage.timeline) for (const [h, x] of Object.entries(p.perHospital)) expect(x.staffedConfirmed + x.staffedExpected, `${clock(p.tMs)} ${h}`).toBe(x.staffed);
    for (const g of r.coverage.gaps) expect(g.staffedConfirmed + g.staffedExpected).toBe(g.staffed);
  });

  it('SYN-005 from 19:00 is AT_RISK before confirmation: 1 confirmed (PHY-005) + 1 expected (PHY-011) vs required 2', () => {
    const r = detect(dataset, et('18:20:00'));
    expect(r.coverage.timeline.find((p) => p.tMs === et('19:00:00'))?.perHospital['SYN-005']).toMatchObject({
      required: 2,
      staffed: 2,
      staffedConfirmed: 1,
      staffedExpected: 1,
      expectedIds: ['PHY-011'],
    });
    const c = interval(r, 'SYN-005', '19:00:00');
    expect(c).toMatchObject({ status: 'AT_RISK', startMs: et('19:00:00'), endMs: et('20:00:00'), required: 2, staffedConfirmed: 1, staffedExpected: 1, rule: 'COVERAGE_ARRIVAL_CONFIRMATION' });
  });

  it('SYN-008 from 20:00 is a HARD_GAP: staffed 1 (expected PHY-011) < required 2', () => {
    const c = interval(detect(dataset, et('18:20:00')), 'SYN-008', '20:00:00');
    expect(c).toMatchObject({ status: 'HARD_GAP', required: 2, staffedConfirmed: 0, staffedExpected: 1, expectedIds: ['PHY-011'] });
  });

  it('appending shift_started for PHY-011 at 19:00:00 makes the arrival CONFIRMED once known; SYN-004 at 20:00 goes AT_RISK -> OK', () => {
    const appended = appendEventText(dataset, shiftStarted('EVT-90101', 'PHY-011', '19:00:00', '19:00:03'), { nowMs: et('19:05:00') });
    expect(appended.accepted.map((e) => e.eventId)).toEqual(['EVT-90101']);
    const without = detect(dataset, et('19:05:00'));
    const withEvent = detect(appended.dataset, et('19:05:00'));
    expect(arrival(without, 'PHY-011')?.confirmation).toBe('expected');
    expect(arrival(withEvent, 'PHY-011')).toMatchObject({ confirmation: 'confirmed', confirmedBy: { eventId: 'EVT-90101', eventTimeMs: et('19:00:00') } });
    // SYN-004 needs 1 from 20:00 and only PHY-011 is staffed there.
    expect(interval(without, 'SYN-004', '20:00:00')).toMatchObject({ status: 'AT_RISK', staffedConfirmed: 0, staffedExpected: 1 });
    expect(interval(withEvent, 'SYN-004', '20:00:00')).toBeUndefined(); // OK intervals are not listed
    expect(withEvent.coverage.timeline.find((p) => p.tMs === et('20:00:00'))?.perHospital['SYN-004']).toMatchObject({ staffedConfirmed: 1, staffedExpected: 0 });
    // SYN-008 stays a HARD_GAP: confirmation does not add capacity (1 < 2).
    expect(interval(withEvent, 'SYN-008', '20:00:00')).toMatchObject({ status: 'HARD_GAP', staffedConfirmed: 1, staffedExpected: 0 });
    // Knowledge time: before the event is ingested it is not known.
    expect(arrival(detect(appended.dataset, et('19:00:02')), 'PHY-011')?.confirmation).toBe('expected');
  });

  it('a shift_started dated before the scheduled start does not confirm it (ARRIVAL_CONFIRMATION_EARLY_TOLERANCE_MIN = 0); exactly at the start does', () => {
    const early = appendEventText(dataset, shiftStarted('EVT-90102', 'PHY-011', '18:59:59', '19:00:01'), { nowMs: et('19:05:00') });
    expect(arrival(detect(early.dataset, et('19:05:00')), 'PHY-011')?.confirmation).toBe('expected');
    const exact = appendEventText(dataset, shiftStarted('EVT-90103', 'PHY-011', '19:00:00', '19:00:01'), { nowMs: et('19:05:00') });
    expect(arrival(detect(exact.dataset, et('19:05:00')), 'PHY-011')?.confirmation).toBe('confirmed');
  });

  it('coverageStatus: HARD_GAP when staffed < required; AT_RISK when confirmed < required <= staffed with zero margin; else OK', () => {
    const x = (required: number, staffedConfirmed: number, staffedExpected: number) =>
      ({ required, staffedConfirmed, staffedExpected, staffed: staffedConfirmed + staffedExpected }) as unknown as HospitalCoverageAt;
    expect(coverageStatus(x(2, 0, 1))).toBe('HARD_GAP');
    expect(coverageStatus(x(2, 1, 1))).toBe('AT_RISK');
    expect(coverageStatus(x(2, 1, 2))).toBe('OK'); // margin 1 > AT_RISK_MAX_MARGIN 0
    expect(coverageStatus(x(2, 2, 0))).toBe('OK');
    expect(coverageStatus(x(0, 0, 0))).toBe('OK');
  });
});
