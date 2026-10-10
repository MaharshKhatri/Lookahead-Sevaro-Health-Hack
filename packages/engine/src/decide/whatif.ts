import { detect, type DetectionReport } from '../detect';
import { projectCoverage, type CoverageProjection } from '../detect/coverage';
import { candidatePhysicians, routableNow } from '../detect/routing';
import { confirmationEvent, etClock, isDayShift, withShifts, type ScheduledShift } from '../detect/staffing';
import { DECISION_HORIZON_MIN, PROJECTION_STEP_MIN } from '../policy';
import type { Dataset, EpochMs } from '../types';
import { computeNeeds, needEndMs } from './needs';
import type { Need } from './types';

/** An accepted split-shift offer, as the what-if treats it. */
export interface AcceptedOffer {
  readonly physicianId: string;
  readonly name: string | null;
  readonly startMs: EpochMs;
  readonly endMs: EpochMs;
  readonly scopeHospitalIds: readonly string[];
  readonly seededConsultCount: number;
}

export interface RoutableAt {
  readonly physicianId: string;
  readonly hospitalId: string;
  readonly atMs: EpochMs;
  readonly count: number;
  readonly ids: readonly string[];
}

export interface WhatIf {
  readonly coverage: CoverageProjection;
  readonly needs: readonly Need[];
  /** Routable count at each offer's scope hospitals at the offer start (OQ-24(b)). */
  readonly routableAtOfferStart: readonly RoutableAt[];
}

export interface NeedChange {
  readonly before: Need;
  readonly outcome: 'closed' | 'downgraded' | 'shortened' | 'unchanged';
  readonly after: readonly Need[];
  readonly detail: string;
}

/**
 * Pure re-projection: accepted offers become staffed and routable (subject to
 * SCOPE, with SEED) at their scope hospitals for their window. Same shape as
 * detect().coverage plus needs.
 */
export function projectWithOffers(dataset: Dataset, nowMs: EpochMs, offers: readonly AcceptedOffer[], decisionHorizonMin = DECISION_HORIZON_MIN): WhatIf {
  return projectWithOffersFrom(dataset, detect(dataset, nowMs), offers, decisionHorizonMin);
}

/** As projectWithOffers, reusing a detection already computed at the same instant. */
export function projectWithOffersFrom(dataset: Dataset, detection: DetectionReport, offers: readonly AcceptedOffer[], decisionHorizonMin = DECISION_HORIZON_MIN): WhatIf {
  const shifts: ScheduledShift[] = offers.map((o) => {
    const confirmedBy = confirmationEvent(detection.state, o.physicianId, o.startMs);
    return {
      physicianId: o.physicianId,
      name: o.name,
      startMs: o.startMs,
      endMs: o.endMs,
      source: 'split_shift_offer',
      dayShift: isDayShift(o.startMs),
      confirmation: confirmedBy === null ? 'expected' : 'confirmed',
      confirmedBy,
      scopeHospitalIds: o.scopeHospitalIds,
      seededConsults: o.seededConsultCount,
    };
  });
  const staffing = withShifts(detection.staffing, shifts);
  const coverage = projectCoverage(dataset, detection.state, staffing, detection.demand, detection.nowMs, { horizonMin: decisionHorizonMin, stepMin: PROJECTION_STEP_MIN }, detection.routability);
  const routableAtOfferStart = offers.flatMap((o) =>
    o.scopeHospitalIds.map((h) => {
      const ids = candidatePhysicians(detection.state, staffing, o.startMs).filter((p) => routableNow(detection.state, staffing, p, h, o.startMs).routable);
      return { physicianId: o.physicianId, hospitalId: h, atMs: o.startMs, count: ids.length, ids };
    }),
  );
  return { coverage, needs: computeNeeds(detection, coverage, staffing, coverage.horizonEndMs), routableAtOfferStart };
}

/** Needs without any offer over the same decision projection as a WhatIf, for a like-for-like before/after (OQ-31). */
export function needsOverDecisionHorizon(detection: DetectionReport, decisionCoverage: CoverageProjection): Need[] {
  return computeNeeds(detection, decisionCoverage, detection.staffing, decisionCoverage.horizonEndMs);
}

const kindRank = (k: Need['kind']) => (k === 'DEADLOCK_NOW' ? 0 : k === 'HARD_GAP' ? 1 : 2);

const segment = (n: Need) => `${n.kind} ${etClock(n.startMs)}-${n.endMs === 'beyond_horizon' ? 'beyond' : etClock(n.endMs)}`;

/** How each need before the offers fares after them (same hospital, overlapping time). */
export function compareNeeds(before: readonly Need[], after: readonly Need[], horizonEndMs: EpochMs): NeedChange[] {
  return before.map((b) => {
    const bEnd = needEndMs(b, horizonEndMs);
    const overlapping = after.filter((a) => a.hospitalId === b.hospitalId && a.startMs < bEnd && needEndMs(a, horizonEndMs) > b.startMs);
    const same = overlapping.filter((a) => a.kind === b.kind);
    const sameMinutes = same.reduce((m, a) => m + (Math.min(bEnd, needEndMs(a, horizonEndMs)) - Math.max(b.startMs, a.startMs)), 0);
    const afterText = overlapping.map(segment).join(', ');
    if (overlapping.length === 0) return { before: b, outcome: 'closed', after: [], detail: 'no remaining need at this hospital in this interval' };
    if (same.length === 0 && overlapping.every((a) => kindRank(a.kind) > kindRank(b.kind))) return { before: b, outcome: 'downgraded', after: overlapping, detail: `now ${afterText}` };
    if (sameMinutes < bEnd - b.startMs) {
      return { before: b, outcome: 'shortened', after: overlapping, detail: `${b.kind} remains for ${Math.round(sameMinutes / 60_000)} of ${Math.round((bEnd - b.startMs) / 60_000)} min; now ${afterText}` };
    }
    return { before: b, outcome: 'unchanged', after: overlapping, detail: 'unchanged' };
  });
}

/** Needs after the offers that overlap no need before them at the same hospital. */
export function introducedNeeds(before: readonly Need[], after: readonly Need[], horizonEndMs: EpochMs): Need[] {
  return after.filter((a) => !before.some((b) => b.hospitalId === a.hospitalId && b.startMs < needEndMs(a, horizonEndMs) && needEndMs(b, horizonEndMs) > a.startMs));
}
