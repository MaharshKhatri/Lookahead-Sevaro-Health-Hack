import { describe, expect, it } from 'vitest';
import {
  FORECAST_HORIZONS_MIN,
  FORECAST_TAIL_TOLERANCE,
  HAWKES_ETA_GRID,
  appendEventText,
  buildBaselineTable,
  buildForecastModel,
  convolve,
  detect,
  fitHawkes,
  forecast,
  hourBuckets,
  integral0,
  negBinPmf,
  negBinPoisson,
  omegaOf,
  pmfMean,
  poissonPmf,
  spikeProbability,
  type Dataset,
  type HawkesFit,
} from '../src';
import { mulberry32 } from '../src/util/rng';
import { dataset } from './detect.helpers';
import { et, seededShuffle } from './helpers';

/**
 * Phase 2: Surge Forecast. Brief Detect layer: "what will need attention in
 * the next 60-90 minutes"; spike test per "Coverage and Split-Shift
 * Eligibility" ("trailing 60-minute consults above the hospital's p90
 * baseline for that hour", OQ-19).
 */

const NOW = et('18:20:00');
const state1820 = detect(dataset, NOW).state;

// log Gamma via Lanczos, for the brute-force NegBin check.
function lgamma(x: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0] ?? 0;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += (c[i] ?? 0) / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const negBinDirect = (n: number, r: number, p: number) => Math.exp(lgamma(n + r) - lgamma(n + 1) - lgamma(r) + r * Math.log(p) + n * Math.log(1 - p));

describe('count distributions (term D)', () => {
  it('NegBin recurrence matches the closed form and sums to 1', () => {
    for (const [r, p] of [[6.9, 0.9], [2.3, 0.5], [15, 0.98], [0.7, 0.3]] as const) {
      const pmf = negBinPmf(r, p, 60);
      for (let n = 0; n <= 20; n++) expect(pmf[n]).toBeCloseTo(negBinDirect(n, r, p), 10);
      if (p >= 0.5) expect(pmf.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
    }
  });

  it('Poisson PMF sums to 1 and the convolution matches a brute-force double sum', () => {
    const a = negBinPmf(7, 0.9);
    const b = poissonPmf(0.6);
    expect(b.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    const c = convolve(a, b);
    for (let n = 0; n < 15; n++) {
      let brute = 0;
      for (let i = 0; i <= n; i++) brute += (a[i] ?? 0) * (b[n - i] ?? 0);
      expect(c[n]).toBeCloseTo(brute, 12);
    }
  });

  it('the convolved PMF sums to 1, its mean equals the analytic mean, and the truncated tail is < 1e-6', () => {
    for (const [r, p, mu] of [[6.9, 0.94, 0.2], [12, 0.8, 1.5], [3, 0.6, 2]] as const) {
      const d = negBinPoisson(r, p, mu);
      expect(d.pmf.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
      expect(d.tailMass).toBeLessThan(FORECAST_TAIL_TOLERANCE);
      expect(pmfMean(d.pmf)).toBeCloseTo(d.mean, 5);
      expect(d.mean).toBeCloseTo((r * (1 - p)) / p + mu, 12);
    }
  });
});

describe('baseline intensity (term A, same hour/zone convention as the detector, OQ-03)', () => {
  it('Lambda0 over one full ET hour equals that hour\'s mean; a half hour is half', () => {
    const table = buildBaselineTable(dataset, et('07:00:00'), et('23:00:00'));
    const h = dataset.hospitals[0]?.hospitalId ?? '';
    const mean18 = dataset.baselineHourly.find((b) => b.hospitalId === h && b.hourStartEt.raw === '18:00')?.meanConsults ?? -1;
    expect(mean18).toBeGreaterThanOrEqual(0);
    expect(integral0(table, h, et('18:00:00'), et('19:00:00'))).toBeCloseTo(mean18, 12);
    expect(integral0(table, h, et('18:30:00'), et('19:00:00'))).toBeCloseTo(mean18 / 2, 12);
    expect(integral0(table, h, et('19:00:00'), et('18:00:00'))).toBe(0);
    expect(hourBuckets(et('18:20:00'), et('20:10:00')).map((b) => b.hour)).toEqual([18, 19, 20]);
  });
});

describe('spike probability (term E) equals the deterministic detector at T = t', () => {
  it('for every hospital at every 5-min asOf across the day (OQ-19 strict >, ET hour p90)', () => {
    const first = Math.min(...dataset.events.map((e) => e.eventTime));
    // The equivalence at T = t does not depend on the Hawkes fit (the future window is empty), so reuse one fit for speed.
    const fit = buildForecastModel(dataset, state1820, NOW).fit;
    let checks = 0;
    for (let t = first; t <= NOW; t += 5 * 60_000) {
      const d = detect(dataset, t);
      const f = forecast(dataset, d.state, t, { fit });
      for (const h of f.hospitals) {
        const flag = d.demand.find((x) => x.hospitalId === h.hospitalId)?.spike ?? false;
        expect(h.checkpoints[0]?.pSpike, `${h.hospitalId} at ${new Date(t).toISOString()}`).toBe(flag ? 1 : 0);
        expect(h.spikeNow).toBe(flag);
        checks++;
      }
    }
    expect(checks).toBeGreaterThan(1000);
  }, 30_000);

  it('at 18:20 the surging hospital has P(spike) = 1 now and still 1 at +15 and +30 (its 5 known consults stay in the window), then falls', () => {
    const f = forecast(dataset, state1820, NOW);
    const surge = f.hospitals.find((h) => h.spikeNow);
    expect(surge).toBeDefined();
    const p = surge?.checkpoints.map((c) => c.pSpike) ?? [];
    expect(p.slice(0, 3)).toEqual([1, 1, 1]);
    expect(p[3]).toBeLessThan(1);
    expect(p[3]).toBeGreaterThan(0);
    expect(surge?.riskRank).toBe(1);
    // A later checkpoint never tests a window longer than 60 min (knownInWindow is 0 once T - 60 > t).
    expect(surge?.checkpoints.filter((c) => c.minutesAhead > 60).every((c) => c.knownInWindow === 0)).toBe(true);
  });
});

describe('drivers and output shape (term F)', () => {
  it('drivers decompose the 60-min expectation exactly and the sentence carries computed numbers', () => {
    const f = forecast(dataset, state1820, NOW);
    expect(f.schemaVersion).toBe('1.0');
    expect(f.hospitals).toHaveLength(dataset.hospitals.length);
    expect([...f.hospitals.map((h) => h.riskRank)].sort((a, b) => a - b)).toEqual(dataset.hospitals.map((_, i) => i + 1));
    for (const h of f.hospitals) {
      const e60 = h.horizons.find((x) => x.minutes === 60)?.expected ?? -1;
      expect(h.drivers.reduce((s, d) => s + d.expected, 0)).toBeCloseTo(e60, 2);
      expect(h.drivers.map((d) => d.kind)).toEqual(['baseline_hour', 'day_rate', 'recent_arrivals']);
      expect(h.driverSentence).toMatch(/^\d+\.\d expected next hour: baseline \d+\.\d · today's rate [+−]\d+\.\d · /);
      expect(h.horizons.map((x) => x.minutes)).toEqual([...FORECAST_HORIZONS_MIN]);
      expect(h.checkpoints).toHaveLength(13);
      expect(h.maxTailMass).toBeLessThan(FORECAST_TAIL_TOLERANCE);
      for (const x of h.horizons) {
        expect(x.p10).toBeLessThanOrEqual(x.p50);
        expect(x.p50).toBeLessThanOrEqual(x.p90);
        expect(x.expectedStroke).toBeLessThanOrEqual(x.expected + 1e-9);
        expect(x.pAtLeast).toHaveLength(5);
        for (let i = 1; i < 5; i++) expect(x.pAtLeast[i]).toBeLessThanOrEqual((x.pAtLeast[i - 1] ?? 0) + 1e-12);
      }
      // Expectations grow with the horizon.
      for (let i = 1; i < h.horizons.length; i++) expect(h.horizons[i]?.expected ?? 0).toBeGreaterThanOrEqual(h.horizons[i - 1]?.expected ?? 0);
    }
  });
});

describe('monotonicity: injecting a consult at h never lowers P(spike)(h, .) or the expected count at h', () => {
  const inject = (ds: Dataset, hospitalId: string, hms: string, nowMs: number): Dataset =>
    appendEventText(ds, `EVT-99001,2026-03-17T${hms}-04:00,2026-03-17T${hms}-04:00,CON-9901,consult_received,,${hospitalId},Stroke consult request received`, { nowMs }).dataset;
  const check = (ds2: Dataset, hospitalId: string, fit: HawkesFit | undefined) => {
    const base = forecast(dataset, state1820, NOW, fit === undefined ? {} : { fit });
    const after = forecast(ds2, detect(ds2, NOW).state, NOW, fit === undefined ? {} : { fit });
    const a = base.hospitals.find((h) => h.hospitalId === hospitalId);
    const b = after.hospitals.find((h) => h.hospitalId === hospitalId);
    expect(a && b).toBeTruthy();
    if (!a || !b) return;
    for (let i = 0; i < a.checkpoints.length; i++) expect(b.checkpoints[i]?.pSpike ?? 0, `${hospitalId} +${a.checkpoints[i]?.minutesAhead}`).toBeGreaterThanOrEqual((a.checkpoints[i]?.pSpike ?? 0) - 1e-9);
    for (let i = 0; i < a.horizons.length; i++) expect(b.horizons[i]?.expected ?? 0).toBeGreaterThanOrEqual((a.horizons[i]?.expected ?? 0) - 1e-9);
  };

  it('with the fit held fixed (the live path memoizes the fit per minute), for every hospital, recent and older injections', () => {
    const fixed = buildForecastModel(dataset, state1820, NOW).fit;
    for (const h of dataset.hospitals) for (const hms of ['18:15:00', '17:00:00', '12:30:00']) check(inject(dataset, h.hospitalId, hms, NOW), h.hospitalId, fixed);
  });

  it('with a refit, a stroke consult injected now at the surging hospital', () => {
    const surge = forecast(dataset, state1820, NOW).hospitals.find((h) => h.spikeNow)?.hospitalId ?? '';
    check(inject(dataset, surge, '18:19:00', NOW), surge, undefined);
  });
});

describe('Hawkes fit (term C)', () => {
  /** Ogata thinning for a Hawkes process with baseline mNet*lambda0_h and an exponential kernel; returns arrivals per hospital. */
  function simulate(seed: number, eta: number, halfLifeMin: number, mNet: number, fromMs: number, toMs: number): Map<string, number[]> {
    const rng = mulberry32(seed);
    const table = buildBaselineTable(dataset, fromMs, toMs);
    const omega = omegaOf(halfLifeMin);
    const out = new Map<string, number[]>();
    for (const h of dataset.hospitals) {
      const times: number[] = [];
      const lambda0 = (t: number) => (mNet * integral0(table, h.hospitalId, t, t + 60_000)) / 60_000; // per ms, piecewise constant
      const peakBase = Math.max(...dataset.baselineHourly.filter((b) => b.hospitalId === h.hospitalId).map((b) => b.meanConsults)) * mNet;
      let t = fromMs;
      while (t < toMs) {
        const exc = (at: number) => times.reduce((s, ti) => s + eta * omega * Math.exp(-omega * (at - ti)), 0);
        const upper = peakBase / 3_600_000 + exc(t);
        t += rng.exponential(upper);
        if (t >= toMs) break;
        if (rng.next() * upper <= lambda0(t) + exc(t)) times.push(t);
      }
      out.set(h.hospitalId, times);
    }
    return out;
  }

  it('recovers eta within 0.1 and the half-life within a factor of 2 on seeded Ogata-thinning simulations (baseline x20 for sample size)', () => {
    const K = 20;
    const scaled: Dataset = { ...dataset, baselineHourly: dataset.baselineHourly.map((b) => ({ ...b, meanConsults: b.meanConsults * K })) };
    const from = et('07:00:00');
    const to = et('18:20:00');
    const table = buildBaselineTable(scaled, from, to);
    const results: { eta: number; halfLifeMin: number; n: number }[] = [];
    for (const seed of [11, 22, 33]) {
      const arrivals = simulate(seed, 0.35, 20, K, from, to);
      // The simulation's baseline is K * lambda0 of the ORIGINAL table = 1 * lambda0 of the scaled table.
      const fit = fitHawkes(table, arrivals, 1, from, to);
      results.push({ eta: fit.eta, halfLifeMin: fit.halfLifeMin, n: fit.n });
    }
    console.log('hawkes recovery (true eta 0.35, half-life 20):', JSON.stringify(results));
    for (const r of results) {
      expect(r.n).toBeGreaterThan(1000);
      expect(Math.abs(r.eta - 0.35)).toBeLessThanOrEqual(0.1);
      // Half-life is weakly identified with a few hundred offspring: within a factor of 2 of the truth.
      expect(r.halfLifeMin).toBeGreaterThanOrEqual(10);
      expect(r.halfLifeMin).toBeLessThanOrEqual(45);
    }
  }, 60_000);

  it('grid search is exhaustive and ties go to the smaller eta then the shorter half-life (eta = 0 ignores the half-life)', () => {
    const table = buildBaselineTable(dataset, et('07:00:00'), et('18:20:00'));
    const fit = fitHawkes(table, new Map(dataset.hospitals.map((h) => [h.hospitalId, []])), 1, et('07:00:00'), et('18:20:00'));
    expect(fit.grid).toHaveLength(13 * 7);
    expect(HAWKES_ETA_GRID).toHaveLength(13);
    expect(fit).toMatchObject({ eta: 0, halfLifeMin: 10, n: 0 });
  });
});

describe('determinism and performance', () => {
  it('byte-identical JSON for repeated runs and for 5 seeded shuffles of the event order', () => {
    const a = JSON.stringify(forecast(dataset, state1820, NOW));
    expect(JSON.stringify(forecast(dataset, state1820, NOW))).toBe(a);
    for (const seed of [1, 2, 3, 4, 5]) {
      const ds: Dataset = { ...dataset, events: seededShuffle(dataset.events, seed) };
      expect(JSON.stringify(forecast(ds, detect(ds, NOW).state, NOW))).toBe(a);
    }
  });

  it('spikeProbability is a pure function of the model', () => {
    const model = buildForecastModel(dataset, state1820, NOW);
    const h = dataset.hospitals[0]?.hospitalId ?? '';
    expect(spikeProbability(model, h, NOW + 30 * 60_000)).toEqual(spikeProbability(model, h, NOW + 30 * 60_000));
  });

  it('fit < 300 ms; forecast with a memoized fit < 50 ms (median of 9, isolated budget x3 under parallel load)', async () => {
    const { expectWithinBudget } = await import('./bench.helpers');
    const times = (f: () => void) => {
      const xs: number[] = [];
      for (let i = 0; i < 9; i++) {
        const t0 = performance.now();
        f();
        xs.push(performance.now() - t0);
      }
      return xs.sort((a, b) => a - b)[4] ?? 0;
    };
    const fitMs = times(() => buildForecastModel(dataset, state1820, NOW));
    const model = buildForecastModel(dataset, state1820, NOW);
    const warmMs = times(() => forecast(dataset, state1820, NOW, { fit: model.fit }));
    expectWithinBudget('forecast fit (buildForecastModel incl. grid search)', fitMs, 300);
    expectWithinBudget('forecast warm (fit memoized)', warmMs, 50);
  });
});
