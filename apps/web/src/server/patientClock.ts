import 'server-only';
import { acceptedOffersOf, patientClockAt, type PatientClock } from '@lookahead/engine';
import type { StoreSnapshot } from './store';

/**
 * GET /api/patient-clock (sprint A2): the single unassigned stroke consult that
 * most needs a human now, straight from the engine (clinical/patientClock.ts:
 * replay at knowledge time, the engine's routability, lexicographic ranking).
 * Accepted offers and activated standbys count as staffing, exactly as in
 * decideWithLog (D-54). No rule is evaluated here. Memoized on
 * (bootId, version, nowMs) like computeView so many SSE clients share one pass.
 */

export interface PatientClockDTO {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly unassignedSinceMs: number;
  readonly unassignedMin: number;
  readonly routingFailureCount: number;
  readonly credentialedRoutableNow: number;
  readonly credentialedTotal: number;
  readonly severity: 'critical' | 'warning';
  readonly rankReason: string;
  readonly neuronsAtRiskEstimate: number;
  readonly candidateCount: number;
}

export interface PatientClockResponse {
  readonly clock: PatientClockDTO | null;
  readonly nowMs: number;
  readonly clockMode: 'paused' | 'playing';
  readonly clockSpeed: number;
  readonly version: number;
}

const toDTO = (c: PatientClock): PatientClockDTO => ({
  consultId: c.consultId,
  hospitalId: c.hospitalId,
  hospitalName: c.hospitalName,
  unassignedSinceMs: c.unassignedSinceMs,
  unassignedMin: c.unassignedMin,
  routingFailureCount: c.routingFailureCount,
  credentialedRoutableNow: c.credentialedRoutableNow,
  credentialedTotal: c.credentialedTotal,
  severity: c.severity,
  rankReason: c.rankReason,
  neuronsAtRiskEstimate: c.neuronsAtRiskEstimate,
  candidateCount: c.candidateCount,
});

const MEMO_SIZE = 4;
const memo: { key: string; clock: PatientClockDTO | null }[] = [];

export function computePatientClock(s: StoreSnapshot): PatientClockResponse {
  const nowMs = s.clock.nowMs;
  const key = `${s.bootId}|${s.version}|${nowMs}`;
  let hit = memo.find((m) => m.key === key);
  if (hit === undefined) {
    const c = patientClockAt(s.dataset, nowMs, acceptedOffersOf(s.log, nowMs));
    hit = { key, clock: c === null ? null : toDTO(c) };
    memo.unshift(hit);
    memo.length = Math.min(memo.length, MEMO_SIZE);
  }
  return { clock: hit.clock, nowMs, clockMode: s.clock.mode, clockSpeed: s.clock.speed, version: s.version };
}
