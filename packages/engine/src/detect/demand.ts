import { DateTime } from 'luxon';
import { BASELINE_HOUR_ZONE, BASELINE_WEEKDAY_DOW_TYPE, DEMAND_SPIKE_WINDOW_MS } from '../policy';
import type { RuleCode } from '../replay/rules';
import type { EventRef, NetworkState } from '../replay/types';
import type { Dataset, EpochMs } from '../types';
import type { StaffingModel } from './staffing';

export interface DemandEvaluation {
  readonly hospitalId: string;
  readonly hospitalName: string;
  /** consult_received with event_time in (now - 60 min, now]. */
  readonly count: number;
  readonly p90: number | null;
  readonly mean: number | null;
  readonly ratioToMean: number | null;
  readonly spike: boolean;
  /** Baseline hour used (ET), e.g. "18:00"; null if no baseline row applies. */
  readonly baselineHourEt: string | null;
  readonly contributingConsultIds: readonly string[];
  readonly rule: RuleCode;
  readonly because: readonly EventRef[];
}

/**
 * Brief "Coverage and Split-Shift Eligibility": "A demand spike (trailing
 * 60-minute consults above the hospital's p90 baseline for that hour)". Window
 * and strict comparison per OQ-19; ET hour buckets per OQ-03. Counts come from
 * replay consult state (receivedMs), never from raw events.
 */
export function evaluateDemand(dataset: Dataset, state: NetworkState, staffing: StaffingModel, nowMs: EpochMs): DemandEvaluation[] {
  const local = DateTime.fromMillis(nowMs, { zone: BASELINE_HOUR_ZONE });
  const hourSec = local.hour * 3600;
  const weekday = local.weekday <= 5;
  const consults = Object.values(state.consults);
  return dataset.hospitals.map((h) => {
    const recent = consults
      .filter((c) => c.hospitalId === h.hospitalId && c.receivedMs !== null && c.receivedMs > nowMs - DEMAND_SPIKE_WINDOW_MS && c.receivedMs <= nowMs)
      .sort((a, b) => (a.receivedMs ?? 0) - (b.receivedMs ?? 0));
    const base = weekday
      ? dataset.baselineHourly.find((b) => b.hospitalId === h.hospitalId && b.dowType === BASELINE_WEEKDAY_DOW_TYPE && b.hourStartEt.secondOfDay === hourSec)
      : undefined;
    const count = recent.length;
    const p90 = base?.p90Consults ?? null;
    const mean = base?.meanConsults ?? null;
    return {
      hospitalId: h.hospitalId,
      hospitalName: h.hospitalName,
      count,
      p90,
      mean,
      ratioToMean: mean === null || mean === 0 ? null : count / mean,
      spike: p90 !== null && count > p90, // OQ-19: strictly greater
      baselineHourEt: base?.hourStartEt.raw ?? null,
      contributingConsultIds: recent.map((c) => c.consultId),
      rule: 'DEMAND_SPIKE_TRAILING_60',
      because: recent.flatMap((c) => {
        const r = staffing.refs.get(c.stageHistory.find((s) => s.stage === 'Received')?.eventId ?? '');
        return r === undefined ? [] : [r];
      }),
    };
  });
}
