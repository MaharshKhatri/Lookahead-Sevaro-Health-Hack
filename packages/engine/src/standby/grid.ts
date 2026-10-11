import type { DecisionReport } from '../decide';
import { coverageStatus, type CoveragePoint } from '../detect/coverage';
import { spikeProbability, type ForecastModel } from '../forecast';
import { STANDBY_CELL_MIN, STANDBY_HORIZON_MIN, STANDBY_STROKE_WEIGHT_FLOOR } from '../policy';
import type { EpochMs } from '../types';
import type { GapCell, HospitalRisk } from './types';

/**
 * 4.1 Gap probability grid. Cells (h, c_k), c_k = t rounded up to 15 min +
 * 15k, out to t + STANDBY_HORIZON_MIN. Supply and the base requirement come
 * from the EXISTING decision projection (OQ-24(a); never reimplemented);
 * P(spike) from the surge forecast (OQ-47).
 *
 *   P_gap = max(deterministic, probabilistic)
 *   deterministic  = 1 if the existing class is HARD_GAP or DEADLOCK, else 0
 *   probabilistic  = 1 if supply < requiredBase; P_spike if supply == requiredBase; else 0
 */

const MIN = 60_000;

export function cellStarts(nowMs: EpochMs): EpochMs[] {
  const step = STANDBY_CELL_MIN * MIN;
  const first = Math.ceil(nowMs / step) * step;
  const out: EpochMs[] = [];
  for (let c = first; c <= nowMs + STANDBY_HORIZON_MIN * MIN; c += step) out.push(c);
  return out;
}

/** The projection point in force at t: the latest point at or before t (staffing only changes at boundaries, and every boundary is a point). */
export function pointAt(timeline: readonly CoveragePoint[], tMs: EpochMs): CoveragePoint | null {
  let best: CoveragePoint | null = null;
  for (const p of timeline) {
    if (p.tMs <= tMs) best = p;
    else break;
  }
  return best;
}

export function buildGapGrid(decision: DecisionReport, model: ForecastModel, nowMs: EpochMs): { readonly cells: GapCell[]; readonly hospitals: HospitalRisk[] } {
  const timeline = decision.decisionCoverage.timeline;
  const deadlocks = decision.needs.filter((n) => n.kind === 'DEADLOCK_NOW');
  const cells: GapCell[] = [];
  for (const h of decision.detection.staffing.hospitals) {
    for (const c of cellStarts(nowMs)) {
      const point = pointAt(timeline, c)?.perHospital[h.hospitalId];
      if (point === undefined) continue;
      const deadlocked = deadlocks.some((n) => n.hospitalId === h.hospitalId && n.startMs <= c && (n.endMs === 'beyond_horizon' || c < n.endMs));
      const existingClass: GapCell['existingClass'] = deadlocked ? 'DEADLOCK' : coverageStatus(point);
      const pDeterministic = existingClass === 'HARD_GAP' || existingClass === 'DEADLOCK' ? 1 : 0;
      const pSpike = spikeProbability(model, h.hospitalId, c).pSpike;
      const supply = point.staffed;
      const requiredBase = point.blockMinimum;
      const pProbabilistic = supply < requiredBase ? 1 : supply === requiredBase ? pSpike : 0;
      cells.push({
        hospitalId: h.hospitalId,
        hospitalName: h.hospitalName,
        startMs: c,
        endMs: c + STANDBY_CELL_MIN * MIN,
        supply,
        staffedConfirmed: point.staffedConfirmed,
        staffedExpected: point.staffedExpected,
        requiredBase,
        existingClass,
        pDeterministic,
        pProbabilistic: round3(pProbabilistic),
        pSpike: round3(pSpike),
        pGap: round3(Math.max(pDeterministic, pProbabilistic)),
        // One extra credentialed physician meets the requirement when the shortfall (incl. a possible +1 spike) is at most one, or relieves a deadlock.
        coverableByOne: deadlocked || supply >= requiredBase - 1,
        rule: pDeterministic === 1 ? (deadlocked ? 'NEED_DEADLOCK_NOW' : 'NEED_HARD_GAP') : 'DEMAND_SPIKE_TRAILING_60',
      });
    }
  }
  const hospitals: HospitalRisk[] = decision.detection.staffing.hospitals.map((h) => {
    const mine = cells.filter((c) => c.hospitalId === h.hospitalId);
    const eum = mine.reduce((s, c) => s + c.pGap * STANDBY_CELL_MIN, 0);
    const share = model.hospitals.get(h.hospitalId)?.strokeShare ?? 0;
    const w = (share + STANDBY_STROKE_WEIGHT_FLOOR) / (1 + STANDBY_STROKE_WEIGHT_FLOOR);
    return {
      hospitalId: h.hospitalId,
      hospitalName: h.hospitalName,
      eum: round1(eum),
      strokeWeight: round3(w),
      weightedEum: round1(eum * w),
      maxPGap: Math.max(0, ...mine.map((c) => c.pGap)),
      firstRiskMs: mine.find((c) => c.pGap > 0)?.startMs ?? null,
    };
  });
  return { cells, hospitals };
}

export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
export const round1 = (x: number): number => Math.round(x * 10) / 10;
