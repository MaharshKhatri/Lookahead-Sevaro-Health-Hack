import { DateTime } from 'luxon';
import {
  FORECAST_CHECKPOINT_HORIZON_MIN,
  FORECAST_CHECKPOINT_STEP_MIN,
  FORECAST_DAY_RATE_LAG_MIN,
  FORECAST_DAY_RATE_PRIOR_A,
  FORECAST_HORIZONS_MIN,
  FORECAST_HOSPITAL_PRIOR_B,
  FORECAST_RISK_RANK_WINDOW_MIN,
  FORECAST_SCHEMA_VERSION,
  STROKE_SHARE_PRIOR_WEIGHT,
  DEMAND_SPIKE_WINDOW_MS,
  BASELINE_HOUR_ZONE,
} from '../policy';
import { compareIds } from '../replay/derive';
import type { NetworkState } from '../replay/types';
import type { Dataset, EpochMs } from '../types';
import { fnv1a } from '../util/hash';
import { buildBaselineTable, integral0, p90At, type BaselineTable } from './baseline';
import { negBinPoisson, pAtLeast, pGreaterThan, quantile, type CountDistribution } from './dist';
import { excitation, fitHawkes, type ArrivalsByHospital, type HawkesFit } from './hawkes';

/**
 * Surge Forecast (Phase 2): a calibrated, explainable, per-hospital
 * probabilistic forecast of consult arrivals and of the brief's spike
 * condition ("trailing 60-minute consults above the hospital's p90 baseline
 * for that hour"), built only on the knowledge-time replay at t. Brief Detect
 * layer: "what will need attention in the next 60-90 minutes".
 *
 *   A. baseline intensity lambda0_h(tau) from baseline_hourly_volume.csv;
 *   B. day-rate multiplier m_h (Gamma-Poisson empirical Bayes on arrivals
 *      older than FORECAST_DAY_RATE_LAG_MIN);
 *   C. self-excitation (Hawkes, exponential kernel, shared eta/halfLife fitted
 *      by grid search; first generation only);
 *   D. predictive count = NegBin background (x) Poisson excitation, thinned by
 *      the hospital's posterior stroke share for the stroke-only forecast;
 *   E. spike probability at a future T: P(known arrivals in (T-60, t] + future
 *      arrivals in (max(t, T-60), T] > p90_h(hour(T))). At T = t this is the
 *      detector's flag exactly.
 *
 * Deviation from the Phase 2 note, recorded in DECISIONS: the future part of
 * the trailing-60 window at T is (max(t, T-60), T], not (t, T], so checkpoints
 * beyond t+60 still test a 60-minute window (the brief's definition).
 */

export interface ForecastHorizon {
  readonly minutes: number;
  readonly expected: number;
  readonly expectedStroke: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  /** P(N >= 1), ..., P(N >= 5). */
  readonly pAtLeast: readonly number[];
}

export interface ForecastCheckpoint {
  readonly tMs: EpochMs;
  readonly minutesAhead: number;
  readonly pSpike: number;
  /** Known arrivals in (T-60, t] plus the expected future arrivals in the rest of the window. */
  readonly expectedTrailing60: number;
  readonly knownInWindow: number;
  readonly p90: number | null;
}

export interface ForecastDriver {
  readonly kind: 'baseline_hour' | 'day_rate' | 'recent_arrivals';
  readonly expected: number;
  readonly text: string;
}

export interface HospitalForecast {
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly observedLast60: number;
  readonly p90Now: number | null;
  /** The deterministic detector's flag now (OQ-19); equals checkpoints[0].pSpike === 1. */
  readonly spikeNow: boolean;
  /** Posterior mean day-rate multiplier m_h = a_h / b_h. */
  readonly multiplier: number;
  readonly strokeShare: number;
  readonly horizons: readonly ForecastHorizon[];
  readonly checkpoints: readonly ForecastCheckpoint[];
  /** Decompose the 60-min expectation exactly: Lambda0 + (m_h - 1) Lambda0 + X_h. */
  readonly drivers: readonly ForecastDriver[];
  /** One sentence, all numbers computed. */
  readonly driverSentence: string;
  readonly riskRank: number;
  /** Largest truncated tail mass over this hospital's PMFs (tests assert < FORECAST_TAIL_TOLERANCE). */
  readonly maxTailMass: number;
}

export interface SurgeForecast {
  readonly schemaVersion: string;
  readonly asOfMs: EpochMs;
  readonly dayStartMs: EpochMs;
  readonly params: { readonly eta: number; readonly halfLifeMin: number; readonly A: number; readonly B: number; readonly mNet: number; readonly fitLogLik: number; readonly fitArrivals: number };
  readonly hospitals: readonly HospitalForecast[];
}

/** Everything the forecast needs at t, built once; `countDistribution` and `spikeProbability` query it. */
export interface ForecastModel {
  readonly nowMs: EpochMs;
  readonly dayStartMs: EpochMs;
  readonly lagEndMs: EpochMs;
  readonly table: BaselineTable;
  readonly arrivals: ArrivalsByHospital;
  readonly fit: HawkesFit;
  readonly mNet: number;
  readonly sNet: number;
  readonly hospitals: ReadonlyMap<string, { readonly a: number; readonly b: number; readonly m: number; readonly strokes: number; readonly general: number; readonly strokeShare: number }>;
}

export interface ForecastOptions {
  /** A Hawkes fit already computed for this (dataset, t) (the web layer memoizes by dataset version + minute). */
  readonly fit?: HawkesFit;
}

const HOUR = 3_600_000;
const MIN = 60_000;

/** A content key for memoizing the fit: the arrivals known at t (ids, times, hospitals) and t floored to the minute. */
export function forecastFitKey(state: NetworkState, nowMs: EpochMs): string {
  const parts: string[] = [];
  for (const c of Object.values(state.consults)) if (c.receivedMs !== null && c.receivedMs <= nowMs) parts.push(`${c.consultId}@${c.receivedMs}@${c.hospitalId ?? ''}`);
  parts.sort();
  return `${fnv1a(parts.join('|'))}|${Math.floor(nowMs / MIN)}`;
}

export function buildForecastModel(dataset: Dataset, state: NetworkState, nowMs: EpochMs, opts: ForecastOptions = {}): ForecastModel {
  const known = dataset.events.filter((e) => e.ingestedAt <= nowMs);
  const first = known.reduce((m, e) => Math.min(m, e.eventTime), Number.POSITIVE_INFINITY);
  const dayStartMs = Number.isFinite(first) ? DateTime.fromMillis(first, { zone: BASELINE_HOUR_ZONE }).startOf('hour').toMillis() : nowMs;
  const lagEndMs = Math.max(dayStartMs, nowMs - FORECAST_DAY_RATE_LAG_MIN * MIN);
  const table = buildBaselineTable(dataset, dayStartMs, nowMs + (FORECAST_CHECKPOINT_HORIZON_MIN + 60) * MIN);
  const arrivals = new Map<string, EpochMs[]>();
  const counts = new Map<string, { strokes: number; general: number; lagged: number }>();
  for (const h of dataset.hospitals) {
    arrivals.set(h.hospitalId, []);
    counts.set(h.hospitalId, { strokes: 0, general: 0, lagged: 0 });
  }
  for (const c of Object.values(state.consults)) {
    if (c.receivedMs === null || c.hospitalId === null || c.receivedMs > nowMs || c.receivedMs <= dayStartMs) continue;
    const list = arrivals.get(c.hospitalId);
    const cnt = counts.get(c.hospitalId);
    if (list === undefined || cnt === undefined) continue; // unknown hospital: no baseline, no forecast row
    list.push(c.receivedMs);
    if (c.consultType === 'Stroke') cnt.strokes++;
    else if (c.consultType === 'General Neuro') cnt.general++;
    if (c.receivedMs <= lagEndMs) cnt.lagged++;
  }
  for (const list of arrivals.values()) list.sort((a, b) => a - b);
  // B. network day-rate multiplier from arrivals older than the lag.
  let nNet = 0;
  let lambdaNet = 0;
  for (const h of dataset.hospitals) {
    nNet += counts.get(h.hospitalId)?.lagged ?? 0;
    lambdaNet += integral0(table, h.hospitalId, dayStartMs, lagEndMs);
  }
  const mNet = (FORECAST_DAY_RATE_PRIOR_A + nNet) / (FORECAST_DAY_RATE_PRIOR_A + lambdaNet);
  let strokesNet = 0;
  let generalNet = 0;
  for (const c of counts.values()) {
    strokesNet += c.strokes;
    generalNet += c.general;
  }
  const sNet = strokesNet + generalNet === 0 ? 0.5 : strokesNet / (strokesNet + generalNet);
  const hospitals = new Map<string, ForecastModel['hospitals'] extends ReadonlyMap<string, infer V> ? V : never>();
  for (const h of dataset.hospitals) {
    const cnt = counts.get(h.hospitalId) ?? { strokes: 0, general: 0, lagged: 0 };
    const a = FORECAST_HOSPITAL_PRIOR_B * mNet + cnt.lagged;
    const b = FORECAST_HOSPITAL_PRIOR_B + integral0(table, h.hospitalId, dayStartMs, lagEndMs);
    const strokeShare = (STROKE_SHARE_PRIOR_WEIGHT * sNet + cnt.strokes) / (STROKE_SHARE_PRIOR_WEIGHT + cnt.strokes + cnt.general);
    hospitals.set(h.hospitalId, { a, b, m: a / b, strokes: cnt.strokes, general: cnt.general, strokeShare });
  }
  const fit = opts.fit ?? fitHawkes(table, arrivals, mNet, dayStartMs, nowMs);
  return { nowMs, dayStartMs, lagEndMs, table, arrivals, fit, mNet, sNet, hospitals };
}

/** D. Predictive count of arrivals at h in the future window (aMs, bMs], a >= t. */
export function countDistribution(model: ForecastModel, hospitalId: string, aMs: EpochMs, bMs: EpochMs): CountDistribution {
  const hp = model.hospitals.get(hospitalId);
  const a = Math.max(aMs, model.nowMs);
  if (hp === undefined || bMs <= a) return { pmf: [1], mean: 0, tailMass: 0 };
  const lambda0 = integral0(model.table, hospitalId, a, bMs);
  const p = hp.b / (hp.b + lambda0);
  const x = excitation(model.fit, model.arrivals.get(hospitalId) ?? [], a, bMs);
  return negBinPoisson(hp.a, p, x);
}

/** Known arrivals at h with event_time in (aMs, bMs] (bMs <= t). */
export function knownArrivals(model: ForecastModel, hospitalId: string, aMs: EpochMs, bMs: EpochMs): number {
  let n = 0;
  for (const ti of model.arrivals.get(hospitalId) ?? []) if (ti > aMs && ti <= Math.min(bMs, model.nowMs)) n++;
  return n;
}

/**
 * E. P(spike at T) = P(K_h(T) > p90_h(hour(T))), K = known arrivals in
 * (T-60, t] + future arrivals in (max(t, T-60), T]. Null p90 (no weekday
 * baseline) means no spike can be evaluated: probability 0, like the detector.
 */
export function spikeProbability(model: ForecastModel, hospitalId: string, tMs: EpochMs): { readonly pSpike: number; readonly known: number; readonly expectedFuture: number; readonly p90: number | null } {
  const p90 = p90At(model.table, hospitalId, tMs);
  const windowStart = tMs - DEMAND_SPIKE_WINDOW_MS;
  const known = knownArrivals(model, hospitalId, windowStart, tMs);
  const dist = countDistribution(model, hospitalId, Math.max(model.nowMs, windowStart), tMs);
  if (p90 === null) return { pSpike: 0, known, expectedFuture: dist.mean, p90 };
  const pSpike = known > p90 ? 1 : pGreaterThan(dist.pmf, p90 - known);
  return { pSpike, known, expectedFuture: dist.mean, p90 };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const fmt1 = (x: number) => r1(x).toFixed(1);
const signed = (x: number) => (r1(x) === 0 ? '+0.0' : `${x > 0 ? '+' : '−'}${fmt1(Math.abs(x))}`);

export function forecast(dataset: Dataset, state: NetworkState, nowMs: EpochMs, opts: ForecastOptions = {}): SurgeForecast {
  const model = buildForecastModel(dataset, state, nowMs, opts);
  const rows = dataset.hospitals.map((h) => hospitalForecast(model, h.hospitalId, h.hospitalName));
  const windowEnd = nowMs + FORECAST_RISK_RANK_WINDOW_MIN * MIN;
  const risk = (r: Omit<HospitalForecast, 'riskRank'>) => Math.max(0, ...r.checkpoints.filter((c) => c.tMs <= windowEnd).map((c) => c.pSpike));
  const e60 = (r: Omit<HospitalForecast, 'riskRank'>) => r.horizons.find((x) => x.minutes === 60)?.expected ?? 0;
  const order = [...rows].sort((a, b) => risk(b) - risk(a) || e60(b) - e60(a) || compareIds(a.hospitalId, b.hospitalId)).map((r) => r.hospitalId);
  return {
    schemaVersion: FORECAST_SCHEMA_VERSION,
    asOfMs: nowMs,
    dayStartMs: model.dayStartMs,
    params: { eta: model.fit.eta, halfLifeMin: model.fit.halfLifeMin, A: FORECAST_DAY_RATE_PRIOR_A, B: FORECAST_HOSPITAL_PRIOR_B, mNet: r3(model.mNet), fitLogLik: r3(model.fit.logLik), fitArrivals: model.fit.n },
    hospitals: rows.map((r) => ({ ...r, riskRank: order.indexOf(r.hospitalId) + 1 })),
  };
}

function hospitalForecast(model: ForecastModel, hospitalId: string, hospitalName: string): Omit<HospitalForecast, 'riskRank'> {
  const t = model.nowMs;
  const hp = model.hospitals.get(hospitalId);
  let maxTail = 0;
  const horizons: ForecastHorizon[] = FORECAST_HORIZONS_MIN.map((minutes) => {
    const d = countDistribution(model, hospitalId, t, t + minutes * MIN);
    maxTail = Math.max(maxTail, d.tailMass);
    return {
      minutes,
      expected: r3(d.mean),
      expectedStroke: r3(d.mean * (hp?.strokeShare ?? 0)),
      p10: quantile(d.pmf, 0.1),
      p50: quantile(d.pmf, 0.5),
      p90: quantile(d.pmf, 0.9),
      pAtLeast: [1, 2, 3, 4, 5].map((k) => r3(pAtLeast(d.pmf, k))),
    };
  });
  const checkpoints: ForecastCheckpoint[] = [];
  for (let k = 0; k * FORECAST_CHECKPOINT_STEP_MIN <= FORECAST_CHECKPOINT_HORIZON_MIN; k++) {
    const T = t + k * FORECAST_CHECKPOINT_STEP_MIN * MIN;
    const s = spikeProbability(model, hospitalId, T);
    checkpoints.push({ tMs: T, minutesAhead: k * FORECAST_CHECKPOINT_STEP_MIN, pSpike: r3(s.pSpike), expectedTrailing60: r3(s.known + s.expectedFuture), knownInWindow: s.known, p90: s.p90 });
  }
  const observedLast60 = knownArrivals(model, hospitalId, t - DEMAND_SPIKE_WINDOW_MS, t);
  const p90Now = p90At(model.table, hospitalId, t);
  // Drivers decompose the 60-min expectation exactly: Lambda0 + (m_h - 1) Lambda0 + X_h.
  const lambda0 = integral0(model.table, hospitalId, t, t + HOUR);
  const dayRate = ((hp?.m ?? 1) - 1) * lambda0;
  const recentTimes = (model.arrivals.get(hospitalId) ?? []).filter((ti) => ti > t - DEMAND_SPIKE_WINDOW_MS && ti <= t);
  const x = excitation(model.fit, model.arrivals.get(hospitalId) ?? [], t, t + HOUR);
  const span = recentTimes.length === 0 ? 0 : Math.round((t - (recentTimes[0] ?? t)) / MIN);
  const drivers: ForecastDriver[] = [
    { kind: 'baseline_hour', expected: r3(lambda0), text: `baseline ${fmt1(lambda0)}` },
    { kind: 'day_rate', expected: r3(dayRate), text: `today's rate ${signed(dayRate)}` },
    {
      kind: 'recent_arrivals',
      expected: r3(x),
      text: recentTimes.length === 0 ? `no consults in the last 60 min ${signed(x)}` : `last ${span} min's ${recentTimes.length} consult${recentTimes.length === 1 ? '' : 's'} ${signed(x)}`,
    },
  ];
  const e60 = lambda0 + dayRate + x;
  return {
    hospitalId,
    hospitalName,
    observedLast60,
    p90Now,
    spikeNow: p90Now !== null && observedLast60 > p90Now,
    multiplier: r3(hp?.m ?? 1),
    strokeShare: r3(hp?.strokeShare ?? 0),
    horizons,
    checkpoints,
    drivers,
    driverSentence: `${fmt1(e60)} expected next hour: ${drivers.map((d) => d.text).join(' · ')}`,
    maxTailMass: maxTail,
  };
}

export { buildBaselineTable, integral0, lambda0At, p90At, hourBuckets, type BaselineTable, type HospitalBaseline } from './baseline';
export { negBinPmf, poissonPmf, convolve, negBinPoisson, pmfMean, quantile, pAtLeast, pGreaterThan, type Pmf, type CountDistribution } from './dist';
export { fitHawkes, hawkesLogLik, excitation, omegaOf, type HawkesFit, type HawkesParams, type ArrivalsByHospital } from './hawkes';
