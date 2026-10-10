import { detect, type DetectionReport } from '../detect';
import { projectCoverage, type CoverageProjection } from '../detect/coverage';
import { DECISION_HORIZON_MIN, PROJECTION_HORIZON_MIN, PROJECTION_STEP_MIN } from '../policy';
import { compareIds } from '../replay/derive';
import type { Dataset, EpochMs } from '../types';
import { buildLedger } from './eligibility';
import { buildInterventions, recommendForTopIssue } from './interventions';
import { gapHospitalsOf, computeNeeds } from './needs';
import { draftOfferMessage } from './offerText';
import { analyzeTrap } from './trap';
import type { GapHospital, Intervention, LedgerEntry, Need, OfferLogEntry, RecommendedOffer, TopIssueRecommendation, TrapAnalysis } from './types';
import { compareNeeds, introducedNeeds, needsOverDecisionHorizon, projectWithOffersFrom, type AcceptedOffer, type NeedChange, type WhatIf } from './whatif';

/**
 * Decide layer: brief "Problem to Solve" layer 2 ("Recommend an intervention,
 * explain why, and identify who must approve it"). Built only on detect() and
 * replay(); pure and deterministic in (dataset, nowMs, opts). LLMs are never
 * in this path.
 */

export interface DecideOptions {
  /** Offers already sent (Session 5 owns the state machine); feeds the safety-constraint rules. */
  readonly offerLog?: readonly OfferLogEntry[];
  /** Detection horizon (default PROJECTION_HORIZON_MIN). Needs must start inside it. */
  readonly horizonMin?: number;
  readonly stepMin?: number;
  /** Decision projection used to trace need ends (default DECISION_HORIZON_MIN, OQ-31). */
  readonly decisionHorizonMin?: number;
}

export interface DecisionReport {
  readonly nowMs: EpochMs;
  readonly detection: DetectionReport;
  /** The longer projection (OQ-31) the needs' ends come from. */
  readonly decisionCoverage: CoverageProjection;
  readonly needs: readonly Need[];
  readonly gapHospitals: readonly GapHospital[];
  readonly ledger: readonly LedgerEntry[];
  readonly recommendedOffer: RecommendedOffer | null;
  /** Advisory trap analyses for scheduled arrivals still expected in the decision horizon (OQ-35). */
  readonly arrivalTraps: readonly TrapAnalysis[];
  readonly interventions: readonly Intervention[];
  readonly recommendation: TopIssueRecommendation | null;
  /**
   * Before/after accepting the recommended offer, both over the full decision
   * projection (needs may start after the detection horizon here, e.g. a gap
   * that reopens when the offer ends; OQ-31).
   */
  readonly whatIf: {
    readonly offers: readonly AcceptedOffer[];
    readonly before: readonly Need[];
    readonly after: WhatIf | null;
    readonly changes: readonly NeedChange[];
    readonly introduced: readonly Need[];
  };
}

export function decide(dataset: Dataset, nowMs: EpochMs, opts: DecideOptions = {}): DecisionReport {
  const detection = detect(dataset, nowMs, { horizonMin: opts.horizonMin ?? PROJECTION_HORIZON_MIN, stepMin: opts.stepMin ?? PROJECTION_STEP_MIN });
  const decisionHorizonMin = Math.max(opts.decisionHorizonMin ?? DECISION_HORIZON_MIN, detection.horizonMin);
  const decisionCoverage = projectCoverage(
    dataset,
    detection.state,
    detection.staffing,
    detection.demand,
    nowMs,
    { horizonMin: decisionHorizonMin, stepMin: opts.stepMin ?? PROJECTION_STEP_MIN },
    detection.routability,
  );
  const needs = computeNeeds(detection, decisionCoverage, detection.staffing);
  const ledger = buildLedger({ detection, roster: dataset.offShiftRoster, needs, decisionHorizonEndMs: decisionCoverage.horizonEndMs, offerLog: opts.offerLog ?? [] });
  const recommendedOffer = recommend(detection, ledger);
  const offers: AcceptedOffer[] =
    recommendedOffer === null
      ? []
      : [
          {
            physicianId: recommendedOffer.physicianId,
            name: recommendedOffer.name,
            startMs: recommendedOffer.window.startMs,
            endMs: recommendedOffer.window.endMs,
            scopeHospitalIds: recommendedOffer.routingScope,
            seededConsultCount: recommendedOffer.seededConsultCount,
          },
        ];
  const after = offers.length === 0 ? null : projectWithOffersFrom(dataset, detection, offers, decisionHorizonMin);
  const before = needsOverDecisionHorizon(detection, decisionCoverage);
  const changes = after === null ? [] : compareNeeds(before, after.needs, decisionCoverage.horizonEndMs);
  const introduced = after === null ? [] : introducedNeeds(before, after.needs, decisionCoverage.horizonEndMs);
  const ctx = { detection, needs, recommendedOffer, whatIf: after, changes };
  const interventions = buildInterventions(ctx);
  return {
    nowMs,
    detection,
    decisionCoverage,
    needs,
    gapHospitals: gapHospitalsOf(needs),
    ledger,
    recommendedOffer,
    arrivalTraps: arrivalTraps(detection, decisionCoverage.horizonEndMs),
    interventions,
    recommendation: recommendForTopIssue(ctx, interventions),
    whatIf: { offers, before, after, changes, introduced },
  };
}

/** The top-ranked eligible physician, with the OQ-35 mitigations and the PHI-checked message. */
function recommend(detection: DetectionReport, ledger: readonly LedgerEntry[]): RecommendedOffer | null {
  const top = ledger.filter((e) => e.rank !== null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))[0];
  if (top === undefined || top.offerWindow === null || top.value === null) return null;
  const trap = analyzeTrap(detection, { physicianId: top.physicianId, startMs: top.offerWindow.startMs, scopeHospitalIds: top.scopeHospitalIds, source: 'split_shift_offer' });
  const routingScope = trap.recommended === 'seed' ? trap.credentialedHospitalIds : top.scopeHospitalIds;
  const seededConsultCount = trap.recommended === 'scope' ? 0 : trap.seededConsultCount;
  const names = routingScope.map((h) => detection.staffing.hospitalNames.get(h) ?? h);
  return {
    physicianId: top.physicianId,
    name: top.name,
    window: top.offerWindow,
    routingScope,
    seededConsultCount,
    value: top.value,
    coversNeeds: top.coversNeeds,
    why: [
      `Rank 1 of ${ledger.filter((e) => e.eligible).length} eligible (of ${ledger.length} off-shift physicians): passes all six eligibility rules and the offer limits.`,
      ...top.rankWhy,
      `Window binding cap: ${top.offerWindow.caps.find((c) => c.kind === top.offerWindow?.bindingCap)?.detail ?? top.offerWindow.bindingCap}.`,
      ...trap.trapWhy,
    ],
    message: draftOfferMessage({ hospitalNames: names, startMs: top.offerWindow.startMs, endMs: top.offerWindow.endMs }),
    trap,
  };
}

function arrivalTraps(detection: DetectionReport, horizonEndMs: EpochMs): TrapAnalysis[] {
  return detection.staffing.shifts
    .filter((s) => s.source === 'scheduled_arrival' && s.confirmation === 'expected' && s.startMs > detection.nowMs && s.startMs <= horizonEndMs)
    .sort((a, b) => a.startMs - b.startMs || compareIds(a.physicianId, b.physicianId))
    .map((s) => analyzeTrap(detection, { physicianId: s.physicianId, startMs: s.startMs, scopeHospitalIds: null, source: 'scheduled_arrival' }));
}

export { DECISION_RIGHTS, type Actor, type InterventionKind } from './brief-rules';
export { computeNeeds, gapHospitalsOf, needEndMs } from './needs';
export { buildLedger, type LedgerContext } from './eligibility';
export { analyzeTrap, medianFloor, type Joiner } from './trap';
export { buildInterventions, recommendForTopIssue, type InterventionContext } from './interventions';
export { projectWithOffers, projectWithOffersFrom, compareNeeds, introducedNeeds, needsOverDecisionHorizon, type AcceptedOffer, type NeedChange, type RoutableAt, type WhatIf } from './whatif';
export { draftOfferMessage, OFFER_MESSAGE_VOCABULARY, type OfferMessageInput } from './offerText';
export { assertNoPHI, findPhiViolations, PHI_DENYLIST } from './phi';
export type * from './types';
