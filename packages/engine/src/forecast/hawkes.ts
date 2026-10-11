/**
 * Term C of the surge forecast: short-term self-excitation as a Hawkes
 * process with an exponential kernel phi(s) = eta * omega * exp(-omega s),
 * omega = ln 2 / halfLife, parameters shared across hospitals and fitted by a
 * deterministic grid search on the point-process log-likelihood over
 * (dayStart, t]. Each hospital excites only itself (a surge at one hospital
 * does not raise another's intensity).
 *
 * Expected excitation in a future window counts the FIRST GENERATION only:
 * offspring of events known at t, not offspring of those offspring. This
 * understates long-horizon excitation slightly and keeps the forecast a
 * closed form (documented, LOOKAHEAD-DEFINED).
 */
import { FORECAST_INTENSITY_FLOOR, HAWKES_ETA_GRID, HAWKES_HALF_LIFE_GRID_MIN } from '../policy';
import type { EpochMs } from '../types';
import { integral0, lambda0At, type BaselineTable } from './baseline';

export interface HawkesParams {
  readonly eta: number;
  readonly halfLifeMin: number;
  /** ln 2 / halfLife, per millisecond. */
  readonly omega: number;
}

export interface HawkesFit extends HawkesParams {
  readonly logLik: number;
  /** Every grid point evaluated, for the quality page. */
  readonly grid: readonly { readonly eta: number; readonly halfLifeMin: number; readonly logLik: number }[];
  /** Arrivals used in the fit. */
  readonly n: number;
}

/** Arrival times per hospital (consult_received event times known at t, in (dayStart, t]). */
export type ArrivalsByHospital = ReadonlyMap<string, readonly EpochMs[]>;

export const omegaOf = (halfLifeMin: number): number => Math.LN2 / (halfLifeMin * 60_000);

/**
 * Expected first-generation excitation arrivals in (aMs, bMs] at one
 * hospital from its arrivals t_i <= t: eta * sum_i [e^(-w(a - t_i)) - e^(-w(b - t_i))].
 */
export function excitation(params: HawkesParams, arrivals: readonly EpochMs[], aMs: EpochMs, bMs: EpochMs): number {
  if (params.eta === 0 || bMs <= aMs) return 0;
  let s = 0;
  for (const ti of arrivals) {
    if (ti > aMs) continue;
    s += Math.exp(-params.omega * (aMs - ti)) - Math.exp(-params.omega * (bMs - ti));
  }
  return params.eta * s;
}

/**
 * Log-likelihood over (dayStart, t] with lambda_h(tau) = mNet * lambda0_h(tau)
 * + sum_{t_i < tau} eta w e^(-w (tau - t_i)) and the closed-form compensator
 * mNet * Lambda0_h(dayStart, t) + eta * sum_i (1 - e^(-w (t - t_i))).
 */
export function hawkesLogLik(params: HawkesParams, table: BaselineTable, arrivals: ArrivalsByHospital, mNet: number, dayStartMs: EpochMs, tMs: EpochMs): number {
  let ll = 0;
  for (const [hospitalId, times] of arrivals) {
    const sorted = [...times].sort((a, b) => a - b);
    for (let j = 0; j < sorted.length; j++) {
      const tj = sorted[j] ?? 0;
      let exc = 0;
      if (params.eta > 0) for (let i = 0; i < j; i++) exc += Math.exp(-params.omega * (tj - (sorted[i] ?? 0)));
      // Intensity in consults per hour: lambda0 is per hour; the kernel's omega is per ms, so scale it to per hour.
      const perHour = mNet * lambda0At(table, hospitalId, tj) + params.eta * params.omega * 3_600_000 * exc;
      ll += Math.log(Math.max(FORECAST_INTENSITY_FLOOR, perHour));
    }
    let comp = mNet * integral0(table, hospitalId, dayStartMs, tMs);
    if (params.eta > 0) for (const ti of sorted) comp += params.eta * (1 - Math.exp(-params.omega * (tMs - ti)));
    ll -= comp;
  }
  return ll;
}

/** Grid search; ties go to the smaller eta, then the shorter half-life (grid order). */
export function fitHawkes(table: BaselineTable, arrivals: ArrivalsByHospital, mNet: number, dayStartMs: EpochMs, tMs: EpochMs): HawkesFit {
  const grid: { eta: number; halfLifeMin: number; logLik: number }[] = [];
  let best: { eta: number; halfLifeMin: number; logLik: number } | null = null;
  for (const eta of HAWKES_ETA_GRID) {
    for (const halfLifeMin of HAWKES_HALF_LIFE_GRID_MIN) {
      const logLik = hawkesLogLik({ eta, halfLifeMin, omega: omegaOf(halfLifeMin) }, table, arrivals, mNet, dayStartMs, tMs);
      grid.push({ eta, halfLifeMin, logLik });
      if (best === null || logLik > best.logLik + 1e-9) best = { eta, halfLifeMin, logLik };
    }
  }
  const b = best ?? { eta: 0, halfLifeMin: HAWKES_HALF_LIFE_GRID_MIN[0] ?? 10, logLik: 0 };
  let n = 0;
  for (const t of arrivals.values()) n += t.length;
  return { ...b, omega: omegaOf(b.halfLifeMin), grid, n };
}
