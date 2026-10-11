import { candidatePhysicians, routableNow } from '../detect/routing';
import { buildStaffingModel, offerShift, withShifts, type AcceptedOffer, type StaffingModel } from '../detect/staffing';
import { compareIds } from '../replay/derive';
import { replay } from '../replay/reduce';
import type { ConsultState, NetworkState } from '../replay/types';
import type { ConsultStage, Dataset, EpochMs } from '../types';
import { NEURONS_LOST_PER_MIN, PATIENT_CLOCK_CRITICAL_MIN, PATIENT_CLOCK_WARNING_MIN } from './constants';

/**
 * Patient clock (final polish sprint, A2). LOOKAHEAD-DEFINED presentation of
 * engine facts: the single unassigned stroke consult that most needs a human
 * now. Every input is an existing engine output:
 *  - candidates: open Stroke consults in Received or Triaged with no physician
 *    assigned (brief "Consult lifecycle": Received -> Triaged -> Assigned);
 *  - routable count: routableNow (brief "How Calls Reach Physicians" rules 1-2),
 *    evaluated for the consult itself so its own ringing call is not "another call";
 *  - routing failures: routing_attempt_failed events for the consult known by
 *    nowMs (brief rule 5: "If nobody is eligible, the routing attempt fails").
 * Ranking is lexicographic and explainable (LOOKAHEAD-DEFINED): (1) nobody
 * routable first, (2) longest unassigned, (3) most routing failures, (4) id.
 * The neurons figure is the illustrative Saver 2006 extrapolation from
 * constants.ts: display only, never a decision input.
 */

/** Brief "Consult lifecycle": the stages before a physician is assigned. */
const PRE_ASSIGNMENT_STAGES: readonly ConsultStage[] = ['Received', 'Triaged'];

const MIN_MS = 60_000;

export type PatientClockSeverity = 'critical' | 'warning';

export interface StrokeClockCandidate {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly unassignedSinceMs: EpochMs;
  /** Exact elapsed milliseconds at nowMs (severity is computed from this, not the rounded minutes). */
  readonly unassignedMs: number;
  readonly routingFailureCount: number;
  /** Physicians who pass routing rules 1-2 for this consult's hospital now. */
  readonly credentialedRoutableNow: number;
  /** Physicians on shift now and credentialed at the hospital (routable or not). */
  readonly credentialedTotal: number;
}

export interface PatientClock {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly unassignedSinceMs: EpochMs;
  /** Minutes unassigned at nowMs, rounded to one decimal. */
  readonly unassignedMin: number;
  readonly routingFailureCount: number;
  readonly credentialedRoutableNow: number;
  readonly credentialedTotal: number;
  readonly severity: PatientClockSeverity;
  /** Plain sentence: why this consult is ranked first. */
  readonly rankReason: string;
  /** Illustrative (Saver 2006): unassignedMin x NEURONS_LOST_PER_MIN, rounded to whole neurons. */
  readonly neuronsAtRiskEstimate: number;
  /** How many unassigned stroke consults were ranked. */
  readonly candidateCount: number;
}

/** Earliest instant the consult is known unassigned: its receipt (the replay never un-assigns). */
function unassignedSince(c: ConsultState): EpochMs | null {
  return c.receivedMs ?? c.stageHistory[0]?.enteredMs ?? c.stageEnteredMs;
}

function isCandidate(c: ConsultState): boolean {
  return c.open && c.consultType === 'Stroke' && c.assignedPhysicianId === null && c.hospitalId !== null && c.stage !== null && PRE_ASSIGNMENT_STAGES.includes(c.stage);
}

/** Unassigned stroke consults at nowMs with their routing facts (state is a replay at knowledge time nowMs). */
export function strokeClockCandidates(state: NetworkState, staffing: StaffingModel, nowMs: EpochMs): StrokeClockCandidate[] {
  const physicians = candidatePhysicians(state, staffing, nowMs);
  return Object.values(state.consults)
    .filter(isCandidate)
    .flatMap((c): StrokeClockCandidate[] => {
      const since = unassignedSince(c);
      const hospitalId = c.hospitalId ?? '';
      if (since === null) return [];
      const checks = physicians.map((p) => routableNow(state, staffing, p, hospitalId, nowMs, { forConsultId: c.consultId }));
      const credentialed = checks.filter((r) => r.reasons.every((x) => (x.rule === 'ROUTE_ON_SHIFT' || x.rule === 'ROUTE_CREDENTIALED' ? x.pass : true)));
      return [
        {
          consultId: c.consultId,
          hospitalId,
          hospitalName: c.hospitalName ?? staffing.hospitalNames.get(hospitalId) ?? hospitalId,
          unassignedSinceMs: since,
          unassignedMs: Math.max(0, nowMs - since),
          routingFailureCount: c.routingFailures.filter((f) => f.atMs <= nowMs).length,
          credentialedRoutableNow: checks.filter((r) => r.routable).length,
          credentialedTotal: credentialed.length,
        },
      ];
    });
}

type RankKey = Pick<StrokeClockCandidate, 'consultId' | 'credentialedRoutableNow' | 'unassignedMs' | 'routingFailureCount'>;

/** Lexicographic ranking (LOOKAHEAD-DEFINED): nobody routable, longest unassigned, most failures, consult id. */
export function compareStrokeClock(a: RankKey, b: RankKey): number {
  const blocked = (c: RankKey) => (c.credentialedRoutableNow === 0 ? 0 : 1);
  return blocked(a) - blocked(b) || b.unassignedMs - a.unassignedMs || b.routingFailureCount - a.routingFailureCount || compareIds(a.consultId, b.consultId);
}

export function rankStrokeClock<T extends RankKey>(candidates: readonly T[]): T[] {
  return [...candidates].sort(compareStrokeClock);
}

/** Critical above PATIENT_CLOCK_CRITICAL_MIN or with nobody routable; warning above PATIENT_CLOCK_WARNING_MIN; else none. */
export function strokeClockSeverity(c: Pick<StrokeClockCandidate, 'unassignedMs' | 'credentialedRoutableNow'>): PatientClockSeverity | null {
  if (c.unassignedMs > PATIENT_CLOCK_CRITICAL_MIN * MIN_MS || c.credentialedRoutableNow === 0) return 'critical';
  if (c.unassignedMs > PATIENT_CLOCK_WARNING_MIN * MIN_MS) return 'warning';
  return null;
}

const minText = (ms: number) => `${(Math.round(ms / 6_000) / 10).toFixed(1)} min`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Which ranking key put `top` above `next`, as a plain sentence. */
export function rankReasonFor(top: StrokeClockCandidate, next: StrokeClockCandidate | undefined, count: number): string {
  const head = top.credentialedRoutableNow === 0 ? `No credentialed physician is routable at ${top.hospitalName} now` : `${top.credentialedRoutableNow} of ${top.credentialedTotal} credentialed physicians are routable at ${top.hospitalName}`;
  if (next === undefined) return `${head}; it is the only unassigned stroke consult.`;
  const lead = `ranked first of ${count} unassigned stroke consults`;
  if ((top.credentialedRoutableNow === 0) !== (next.credentialedRoutableNow === 0)) return `${head}; ${lead} because nobody can take it, while ${next.consultId} has ${next.credentialedRoutableNow} routable.`;
  if (top.unassignedMs !== next.unassignedMs) return `${head}; ${lead} because it has waited longest (${minText(top.unassignedMs)} vs ${minText(next.unassignedMs)} for ${next.consultId}).`;
  if (top.routingFailureCount !== next.routingFailureCount)
    return `${head}; ${lead} on routing failures (${plural(top.routingFailureCount, 'failure', 'failures')} vs ${next.routingFailureCount} for ${next.consultId}).`;
  return `${head}; ${lead}: tied with ${next.consultId} on availability, wait and failures, ordered by consult id.`;
}

/** The top unassigned stroke consult at nowMs, or null when none is past the warning threshold. */
export function topUnassignedStroke(state: NetworkState, staffing: StaffingModel, nowMs: EpochMs): PatientClock | null {
  const ranked = rankStrokeClock(strokeClockCandidates(state, staffing, nowMs));
  const top = ranked[0];
  if (top === undefined) return null;
  // The ranking puts the most severe first: nobody-routable is always critical, and among the rest the longest wait leads.
  const severity = strokeClockSeverity(top);
  if (severity === null) return null;
  const unassignedMinExact = top.unassignedMs / MIN_MS;
  return {
    consultId: top.consultId,
    hospitalId: top.hospitalId,
    hospitalName: top.hospitalName,
    unassignedSinceMs: top.unassignedSinceMs,
    unassignedMin: Math.round(unassignedMinExact * 10) / 10,
    routingFailureCount: top.routingFailureCount,
    credentialedRoutableNow: top.credentialedRoutableNow,
    credentialedTotal: top.credentialedTotal,
    severity,
    rankReason: rankReasonFor(top, ranked[1], ranked.length),
    neuronsAtRiskEstimate: Math.round(unassignedMinExact * NEURONS_LOST_PER_MIN),
    candidateCount: ranked.length,
  };
}

/** Convenience: replay at knowledge time nowMs plus staffing (accepted offers count as shifts, as in detect()). */
export function patientClockAt(dataset: Dataset, nowMs: EpochMs, acceptedOffers: readonly AcceptedOffer[] = []): PatientClock | null {
  const state = replay(dataset, nowMs);
  const staffing = withShifts(
    buildStaffingModel(dataset, state),
    acceptedOffers.map((o) => offerShift(state, o)),
  );
  return topUnassignedStroke(state, staffing, nowMs);
}
