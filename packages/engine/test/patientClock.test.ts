import { describe, expect, it } from 'vitest';
import {
  NEURONS_LOST_PER_MIN,
  PATIENT_CLOCK_CRITICAL_MIN,
  PATIENT_CLOCK_WARNING_MIN,
  buildStaffingModel,
  chooseRoute,
  compareStrokeClock,
  dedupe,
  knownAt,
  patientClockAt,
  rankReasonFor,
  rankStrokeClock,
  replay,
  strokeClockSeverity,
  topUnassignedStroke,
  type StrokeClockCandidate,
} from '../src';
import { compareIds } from '../src/replay/derive';
import { dataset } from './detect.helpers';
import { et } from './helpers';

/**
 * Sprint A2 patient clock (LOOKAHEAD-DEFINED presentation of engine facts).
 * Candidates follow brief "Consult lifecycle" (Received -> Triaged -> Assigned):
 * an open Stroke consult before Assigned. Availability is the engine's routing
 * (brief "How Calls Reach Physicians" rules 1-2); failures are brief rule 5
 * ("If nobody is eligible, the routing attempt fails") as routing_attempt_failed.
 */

const MIN = 60_000;

const cand = (over: Partial<StrokeClockCandidate> & Pick<StrokeClockCandidate, 'consultId'>): StrokeClockCandidate => ({
  hospitalId: 'H-A',
  hospitalName: 'Hospital A',
  unassignedSinceMs: 0,
  unassignedMs: 8 * MIN,
  routingFailureCount: 0,
  credentialedRoutableNow: 1,
  credentialedTotal: 3,
  ...over,
});

describe('compareStrokeClock (lexicographic, LOOKAHEAD-DEFINED)', () => {
  it('(1) nobody routable beats 3 routable at equal minutes, whatever the input order', () => {
    const blocked = cand({ consultId: 'C-2', credentialedRoutableNow: 0 });
    const open = cand({ consultId: 'C-1', credentialedRoutableNow: 3 });
    expect(rankStrokeClock([open, blocked])[0]?.consultId).toBe('C-2');
    expect(rankStrokeClock([blocked, open])[0]?.consultId).toBe('C-2');
  });

  it('(1) beats (2): a blocked consult outranks a longer-waiting routable one', () => {
    const blocked = cand({ consultId: 'C-1', credentialedRoutableNow: 0, unassignedMs: 6 * MIN });
    const longer = cand({ consultId: 'C-2', credentialedRoutableNow: 2, unassignedMs: 30 * MIN });
    expect(rankStrokeClock([longer, blocked]).map((c) => c.consultId)).toEqual(['C-1', 'C-2']);
  });

  it('(2) longest unassigned first within the same availability class', () => {
    const a = cand({ consultId: 'C-1', credentialedRoutableNow: 0, unassignedMs: 7 * MIN });
    const b = cand({ consultId: 'C-2', credentialedRoutableNow: 0, unassignedMs: 12 * MIN });
    expect(rankStrokeClock([a, b])[0]?.consultId).toBe('C-2');
  });

  it('(3) most routing failures at equal availability class and wait', () => {
    const a = cand({ consultId: 'C-1', routingFailureCount: 1 });
    const b = cand({ consultId: 'C-2', routingFailureCount: 4 });
    expect(rankStrokeClock([a, b])[0]?.consultId).toBe('C-2');
  });

  it('(4) deterministic final tie-break by consult id (compareIds)', () => {
    const a = cand({ consultId: 'C-10' });
    const b = cand({ consultId: 'C-9' });
    const expected = [a, b].sort((x, y) => compareIds(x.consultId, y.consultId))[0]?.consultId;
    expect(rankStrokeClock([a, b])[0]?.consultId).toBe(expected);
    expect(rankStrokeClock([b, a])[0]?.consultId).toBe(expected);
    expect(compareStrokeClock(a, a)).toBe(0);
  });

  it('rankReason names the key that decided the order', () => {
    const blocked = cand({ consultId: 'C-1', credentialedRoutableNow: 0 });
    const open = cand({ consultId: 'C-2', credentialedRoutableNow: 3 });
    expect(rankReasonFor(blocked, open, 2)).toContain('because nobody can take it');
    const longer = cand({ consultId: 'C-3', unassignedMs: 20 * MIN });
    expect(rankReasonFor(longer, open, 2)).toContain('waited longest');
    const failing = cand({ consultId: 'C-4', routingFailureCount: 2 });
    expect(rankReasonFor(failing, open, 2)).toContain('routing failures');
    expect(rankReasonFor(cand({ consultId: 'C-5' }), cand({ consultId: 'C-6' }), 2)).toContain('ordered by consult id');
    expect(rankReasonFor(blocked, undefined, 1)).toContain('only unassigned stroke consult');
  });
});

describe('strokeClockSeverity (constants.ts thresholds)', () => {
  it('critical above the critical threshold or with nobody routable; warning above the warning threshold; else none', () => {
    expect(strokeClockSeverity({ unassignedMs: PATIENT_CLOCK_CRITICAL_MIN * MIN + 1, credentialedRoutableNow: 2 })).toBe('critical');
    expect(strokeClockSeverity({ unassignedMs: 1, credentialedRoutableNow: 0 })).toBe('critical');
    expect(strokeClockSeverity({ unassignedMs: PATIENT_CLOCK_CRITICAL_MIN * MIN, credentialedRoutableNow: 2 })).toBe('warning');
    expect(strokeClockSeverity({ unassignedMs: PATIENT_CLOCK_WARNING_MIN * MIN + 1, credentialedRoutableNow: 2 })).toBe('warning');
    expect(strokeClockSeverity({ unassignedMs: PATIENT_CLOCK_WARNING_MIN * MIN, credentialedRoutableNow: 2 })).toBeNull();
  });
});

/** Independent derivation from replay at knowledge time: brief lifecycle filter + the engine's own router. */
function expectedTop(nowMs: number): { consultId: string; routable: number; failures: number; sinceMs: number; count: number } | null {
  const state = replay(dataset, nowMs);
  const staffing = buildStaffingModel(dataset, state);
  const known = dedupe(knownAt(dataset.events, nowMs)).events;
  const rows = Object.values(state.consults)
    .filter((c) => c.open && c.consultType === 'Stroke' && c.assignedPhysicianId === null && (c.stage === 'Received' || c.stage === 'Triaged'))
    .map((c) => {
      const route = chooseRoute(state, staffing, c.hospitalId ?? '', nowMs, { forConsultId: c.consultId });
      const sinceMs = c.receivedMs ?? c.stageEnteredMs ?? nowMs;
      return {
        consultId: c.consultId,
        routable: route.ranked.length,
        failures: known.filter((e) => e.eventType === 'routing_attempt_failed' && e.consultId === c.consultId).length,
        sinceMs,
        waitMs: nowMs - sinceMs,
      };
    });
  rows.sort((a, b) => (a.routable === 0 ? 0 : 1) - (b.routable === 0 ? 0 : 1) || b.waitMs - a.waitMs || b.failures - a.failures || compareIds(a.consultId, b.consultId));
  const top = rows[0];
  return top === undefined ? null : { ...top, count: rows.length };
}

describe('topUnassignedStroke on data/raw (knowledge time)', () => {
  // Instants chosen to span the reference evening; expectations are derived from replay, never literals.
  const instants = ['17:30:00', '18:00:00', '18:10:00', '18:20:00', '18:40:00', '19:00:00'].map(et);

  it.each(instants)('at %d (epoch ms) the top consult matches an independent replay derivation', (nowMs) => {
    const got = patientClockAt(dataset, nowMs);
    const exp = expectedTop(nowMs);
    if (exp === null) {
      expect(got).toBeNull();
      return;
    }
    const severity = strokeClockSeverity({ unassignedMs: nowMs - exp.sinceMs, credentialedRoutableNow: exp.routable });
    if (severity === null) {
      expect(got).toBeNull();
      return;
    }
    expect(got?.consultId).toBe(exp.consultId);
    expect(got?.credentialedRoutableNow).toBe(exp.routable);
    expect(got?.routingFailureCount).toBe(exp.failures);
    expect(got?.unassignedSinceMs).toBe(exp.sinceMs);
    expect(got?.candidateCount).toBe(exp.count);
    expect(got?.severity).toBe(severity);
    expect(got?.credentialedTotal).toBeGreaterThanOrEqual(got?.credentialedRoutableNow ?? 0);
    expect(got?.neuronsAtRiskEstimate).toBe(Math.round(((nowMs - exp.sinceMs) / MIN) * NEURONS_LOST_PER_MIN));
    expect(got?.rankReason.length).toBeGreaterThan(0);
  });

  it('the reference evening produces a clock at 18:20 and a different asOf changes the answer honestly', () => {
    const at1820 = patientClockAt(dataset, et('18:20:00'));
    expect(at1820).not.toBeNull();
    // Before the consult was received the same consult cannot be on the clock.
    const before = patientClockAt(dataset, (at1820?.unassignedSinceMs ?? 0) - 1);
    expect(before?.consultId).not.toBe(at1820?.consultId);
    // Elapsed grows with asOf for the same consult; failures never decrease (knowledge time).
    const later = patientClockAt(dataset, et('18:20:00') + 5 * MIN);
    if (later !== null && later.consultId === at1820?.consultId) {
      expect(later.unassignedMin).toBeGreaterThan(at1820.unassignedMin);
      expect(later.routingFailureCount).toBeGreaterThanOrEqual(at1820.routingFailureCount);
    }
  });

  it('is pure: same inputs, same output', () => {
    const now = et('18:20:00');
    const state = replay(dataset, now);
    const staffing = buildStaffingModel(dataset, state);
    expect(topUnassignedStroke(state, staffing, now)).toEqual(topUnassignedStroke(state, staffing, now));
  });
});
