import { DateTime } from 'luxon';
import { BASELINE_HOUR_ZONE, BASELINE_WEEKDAY_DOW_TYPE } from '../policy';
import type { Dataset, EpochMs } from '../types';

/**
 * Term A of the surge forecast: the baseline intensity lambda0_h(tau) is the
 * hospital's 12-week weekday mean for the ET hour bucket containing tau
 * (baseline_hourly_volume.csv, mean_consults per hour). Same hour and
 * time-zone convention as the demand-spike detector (OQ-03, OQ-19): ET hour
 * buckets, weekday rows only; a day with no baseline row has intensity 0 and
 * no p90, so no spike can be evaluated there (OQ-03 addendum).
 */

export interface HospitalBaseline {
  readonly hospitalId: string;
  /** Hour of day (ET) -> mean consults per hour; missing hours are 0. */
  readonly mean: readonly number[];
  /** Hour of day (ET) -> p90 consults per trailing hour; null where no row exists. */
  readonly p90: readonly (number | null)[];
}

export interface BaselineTable {
  readonly byHospital: ReadonlyMap<string, HospitalBaseline>;
  /** Hour buckets [startMs, endMs) covering the range asked for, in order. */
  readonly buckets: readonly { readonly startMs: EpochMs; readonly endMs: EpochMs; readonly hour: number; readonly weekday: boolean }[];
}

export function buildBaselineTable(dataset: Dataset, fromMs: EpochMs, toMs: EpochMs): BaselineTable {
  const byHospital = new Map<string, HospitalBaseline>();
  for (const h of dataset.hospitals) {
    const mean = new Array<number>(24).fill(0);
    const p90 = new Array<number | null>(24).fill(null);
    for (const b of dataset.baselineHourly) {
      if (b.hospitalId !== h.hospitalId || b.dowType !== BASELINE_WEEKDAY_DOW_TYPE) continue;
      const hour = Math.floor(b.hourStartEt.secondOfDay / 3600) % 24;
      mean[hour] = b.meanConsults;
      p90[hour] = b.p90Consults;
    }
    byHospital.set(h.hospitalId, { hospitalId: h.hospitalId, mean, p90 });
  }
  return { byHospital, buckets: hourBuckets(fromMs, toMs) };
}

/** ET hour buckets covering [fromMs, toMs]. */
export function hourBuckets(fromMs: EpochMs, toMs: EpochMs): BaselineTable['buckets'] {
  const out: { startMs: EpochMs; endMs: EpochMs; hour: number; weekday: boolean }[] = [];
  let cur = DateTime.fromMillis(fromMs, { zone: BASELINE_HOUR_ZONE }).startOf('hour');
  let guard = 0;
  while (cur.toMillis() <= toMs && guard++ < 24 * 14) {
    const next = cur.plus({ hours: 1 }).startOf('hour');
    out.push({ startMs: cur.toMillis(), endMs: next.toMillis(), hour: cur.hour, weekday: cur.weekday <= 5 });
    cur = next;
  }
  return out;
}

/** lambda0_h at an instant (consults per hour). */
export function lambda0At(table: BaselineTable, hospitalId: string, tMs: EpochMs): number {
  const h = table.byHospital.get(hospitalId);
  if (h === undefined) return 0;
  const local = DateTime.fromMillis(tMs, { zone: BASELINE_HOUR_ZONE });
  return local.weekday <= 5 ? (h.mean[local.hour] ?? 0) : 0;
}

/** p90 for the ET hour containing T (the detector's "p90 baseline for that hour"); null without a weekday baseline row. */
export function p90At(table: BaselineTable, hospitalId: string, tMs: EpochMs): number | null {
  const h = table.byHospital.get(hospitalId);
  if (h === undefined) return null;
  const local = DateTime.fromMillis(tMs, { zone: BASELINE_HOUR_ZONE });
  return local.weekday <= 5 ? (h.p90[local.hour] ?? null) : null;
}

/** Integrated baseline Lambda0_h(a, b) over (a, b], piecewise constant per ET hour bucket (expected consults). */
export function integral0(table: BaselineTable, hospitalId: string, aMs: EpochMs, bMs: EpochMs): number {
  if (bMs <= aMs) return 0;
  const h = table.byHospital.get(hospitalId);
  if (h === undefined) return 0;
  let total = 0;
  let covered = false;
  for (const bk of table.buckets) {
    if (bk.endMs <= aMs) continue;
    if (bk.startMs >= bMs) break;
    covered = true;
    const overlap = Math.min(bMs, bk.endMs) - Math.max(aMs, bk.startMs);
    if (overlap > 0 && bk.weekday) total += (h.mean[bk.hour] ?? 0) * (overlap / 3_600_000);
  }
  if (!covered) {
    // Outside the precomputed buckets: fall back to a direct walk (rare; keeps the function total).
    for (const bk of hourBuckets(aMs, bMs)) {
      const overlap = Math.min(bMs, bk.endMs) - Math.max(aMs, bk.startMs);
      if (overlap > 0 && bk.weekday) total += (h.mean[bk.hour] ?? 0) * (overlap / 3_600_000);
    }
  }
  return total;
}
