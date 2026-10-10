import { PROJECTION_HORIZON_MIN, PROJECTION_STEP_MIN } from '../policy';
import { replay } from '../replay/reduce';
import type { NetworkState } from '../replay/types';
import type { Dataset, EpochMs } from '../types';
import { buildAttention, type AttentionItem } from './attention';
import { MIN_PROJECTION_HORIZON_MIN } from './brief-rules';
import { projectCoverage, type CoverageProjection } from './coverage';
import { evaluateDemand, type DemandEvaluation } from './demand';
import { candidatePhysicians, chooseRoute, findRoutingDeadlocks, routableNow, type DeadlockFinding, type Routability, type RouteChoice } from './routing';
import { buildStaffingModel, offerShift, withShifts, type AcceptedOffer, type StaffingModel } from './staffing';
import { evaluateOpenNotes, evaluateStandards, type OpenNotesEvaluation, type StandardEvaluation } from './standards';

export interface DetectOptions {
  /** Projection horizon in minutes (default policy.PROJECTION_HORIZON_MIN; must be >= 90). */
  readonly horizonMin?: number;
  readonly stepMin?: number;
  /** Accepted split-shift offers (Act layer): count as scoped, seeded shifts from their start. */
  readonly acceptedOffers?: readonly AcceptedOffer[];
}

export interface DetectionReport {
  readonly nowMs: EpochMs;
  readonly horizonMin: number;
  /** The replay this report is built on (correct mode, knowledge at nowMs). */
  readonly state: NetworkState;
  readonly staffing: StaffingModel;
  /** hospitalId -> physicianId -> routing rules 1-2 with reasons (OQ-24(b)). */
  readonly routability: Readonly<Record<string, Readonly<Record<string, Routability>>>>;
  /** hospitalId -> who routing would pick now (rules 3-5). */
  readonly routes: Readonly<Record<string, RouteChoice>>;
  readonly deadlocks: readonly DeadlockFinding[];
  readonly standards: readonly StandardEvaluation[];
  readonly openNotes: readonly OpenNotesEvaluation[];
  readonly demand: readonly DemandEvaluation[];
  readonly coverage: CoverageProjection;
  readonly attention: readonly AttentionItem[];
}

/** Detect layer (brief "Problem to Solve", layer 1). Pure: everything derives from replay(dataset, nowMs). */
export function detect(dataset: Dataset, nowMs: EpochMs, opts: DetectOptions = {}): DetectionReport {
  const horizonMin = opts.horizonMin ?? PROJECTION_HORIZON_MIN;
  const stepMin = opts.stepMin ?? PROJECTION_STEP_MIN;
  if (horizonMin < MIN_PROJECTION_HORIZON_MIN) throw new RangeError(`projection horizon ${horizonMin} min is below the brief's ${MIN_PROJECTION_HORIZON_MIN} min`);
  if (stepMin <= 0) throw new RangeError('projection step must be positive');

  const state = replay(dataset, nowMs);
  const staffing = withShifts(buildStaffingModel(dataset, state), (opts.acceptedOffers ?? []).map((o) => offerShift(state, o)));
  const physicians = candidatePhysicians(state, staffing, nowMs);
  const routability: Record<string, Record<string, Routability>> = {};
  const routes: Record<string, RouteChoice> = {};
  for (const h of dataset.hospitals) {
    const row = Object.fromEntries(physicians.map((p) => [p, routableNow(state, staffing, p, h.hospitalId, nowMs)]));
    routability[h.hospitalId] = row;
    routes[h.hospitalId] = chooseRoute(state, staffing, h.hospitalId, nowMs, { precomputed: row });
  }
  const deadlocks = findRoutingDeadlocks(state, staffing, nowMs);
  const standards = evaluateStandards(state, staffing, nowMs);
  const openNotes = evaluateOpenNotes(state, staffing, nowMs);
  const demand = evaluateDemand(dataset, state, staffing, nowMs);
  const coverage = projectCoverage(dataset, state, staffing, demand, nowMs, { horizonMin, stepMin }, routability);
  const attention = buildAttention({ state, staffing, nowMs, horizonMin, standards, openNotes, demand, coverage, deadlocks });
  return { nowMs, horizonMin, state, staffing, routability, routes, deadlocks, standards, openNotes, demand, coverage, attention };
}

export { buildAttention, type AttentionItem, type AttentionKind, type Severity } from './attention';
export { OPERATIONAL_STANDARDS, CALL_COOLDOWN_MS, LOW_VOLUME_MAX_CONSULTS, MIN_PROJECTION_HORIZON_MIN, type StandardCode, type StandardDef } from './brief-rules';
export {
  projectCoverage,
  coverageStatus,
  intervalCauses,
  type CoverageProjection,
  type CoverageGap,
  type CoveragePoint,
  type CoverageCause,
  type CoverageInterval,
  type CoverageStatus,
  type HospitalCoverageAt,
  type ProjectionOptions,
} from './coverage';
export { evaluateDemand, type DemandEvaluation } from './demand';
export {
  routableNow,
  chooseRoute,
  candidatePhysicians,
  findRoutingDeadlocks,
  blockingExclusions,
  compareRouteCandidates,
  type RankKey,
  type Routability,
  type RouteCheck,
  type RouteChoice,
  type RouteCandidate,
  type RouteOptions,
  type DeadlockFinding,
} from './routing';
export { buildStaffingModel, confirmationEvent, isDayShift, offerShift, shiftCountsAt, shiftsAt, withShifts, etClock, etClockS, type AcceptedOffer, type StaffingModel, type ScheduledShift } from './staffing';
export { evaluateStandards, evaluateOpenNotes, type StandardEvaluation, type OpenNotesEvaluation, type Level } from './standards';
