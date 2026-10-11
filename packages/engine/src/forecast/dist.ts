/**
 * Count distributions for the surge forecast (term D): a negative-binomial
 * background (Gamma-Poisson mixture over the day-rate multiplier) convolved
 * with a Poisson excitation term, truncated at FORECAST_N_MAX and renormalized.
 * Pure arithmetic; every PMF sums to 1 within floating-point error.
 */
import { FORECAST_N_MAX } from '../policy';

/** Probability mass function over counts 0..n-1. */
export type Pmf = readonly number[];

/** NegBin(r, p) via the recurrence P(0) = p^r, P(n) = P(n-1) * (n-1+r)/n * (1-p). r > 0, 0 < p <= 1. */
export function negBinPmf(r: number, p: number, nMax = FORECAST_N_MAX): Pmf {
  if (!(r > 0) || !(p > 0) || p > 1) throw new RangeError(`negBinPmf: r=${r} p=${p}`);
  const out = new Array<number>(nMax + 1).fill(0);
  let cur = Math.exp(r * Math.log(p));
  out[0] = cur;
  for (let n = 1; n <= nMax; n++) {
    cur = (cur * (n - 1 + r) * (1 - p)) / n;
    out[n] = cur;
  }
  return out;
}

/** Poisson(mu) truncated at nMax. */
export function poissonPmf(mu: number, nMax = FORECAST_N_MAX): Pmf {
  if (!(mu >= 0)) throw new RangeError(`poissonPmf: mu=${mu}`);
  const out = new Array<number>(nMax + 1).fill(0);
  let cur = Math.exp(-mu);
  out[0] = cur;
  for (let n = 1; n <= nMax; n++) {
    cur = (cur * mu) / n;
    out[n] = cur;
  }
  return out;
}

/** Discrete convolution truncated to the shorter support. */
export function convolve(a: Pmf, b: Pmf): number[] {
  const n = Math.min(a.length, b.length);
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    if (ai === 0) continue;
    for (let j = 0; i + j < n; j++) out[i + j] = (out[i + j] ?? 0) + ai * (b[j] ?? 0);
  }
  return out;
}

export interface CountDistribution {
  readonly pmf: Pmf;
  /** Analytic mean before truncation (NegBin mean + Poisson mean). */
  readonly mean: number;
  /** Mass beyond FORECAST_N_MAX before renormalization; must be < FORECAST_TAIL_TOLERANCE (asserted by tests, reported here). */
  readonly tailMass: number;
}

/** NegBin(r, p) (x) Poisson(mu), truncated at nMax and renormalized. */
export function negBinPoisson(r: number, p: number, mu: number, nMax = FORECAST_N_MAX): CountDistribution {
  const raw = convolve(negBinPmf(r, p, nMax), poissonPmf(mu, nMax));
  const mass = raw.reduce((s, x) => s + x, 0);
  const tailMass = Math.max(0, 1 - mass);
  const pmf = mass > 0 ? raw.map((x) => x / mass) : raw;
  return { pmf, mean: (r * (1 - p)) / p + mu, tailMass };
}

export function pmfMean(pmf: Pmf): number {
  return pmf.reduce((s, x, n) => s + n * x, 0);
}

/** Smallest n with P(N <= n) >= q. */
export function quantile(pmf: Pmf, q: number): number {
  let acc = 0;
  for (let n = 0; n < pmf.length; n++) {
    acc += pmf[n] ?? 0;
    if (acc >= q - 1e-12) return n;
  }
  return pmf.length - 1;
}

/** P(N >= k). */
export function pAtLeast(pmf: Pmf, k: number): number {
  if (k <= 0) return 1;
  let below = 0;
  for (let n = 0; n < Math.min(k, pmf.length); n++) below += pmf[n] ?? 0;
  return Math.max(0, Math.min(1, 1 - below));
}

/** P(N > x) for a real threshold x (the detector's strict comparison, OQ-19). */
export function pGreaterThan(pmf: Pmf, x: number): number {
  if (x < 0) return 1;
  return pAtLeast(pmf, Math.floor(x) + 1);
}
