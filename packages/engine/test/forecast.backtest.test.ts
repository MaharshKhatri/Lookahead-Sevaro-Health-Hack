import { describe, expect, it } from 'vitest';
import { BACKTEST_DESIGN, MODEL_IDS, backtest, countIn, knownDataset, realizedArrivals, rollingOrigins, scorePmf } from '../../../scripts/lib/backtest';
import { forecast, poissonPmf, replay, type Dataset } from '../src';
import { dataset } from './detect.helpers';

/**
 * Forecast backtest (docs/FORECAST_BACKTEST.md, D-85/D-86, OQ-47). The
 * backtest core is pure, so the same `backtest(dataset)` the report script
 * writes from is checked here for knowledge-time leakage, determinism and
 * basic sanity. Brief: "Every event carries both event_time and ingested_at.
 * State built only from arrival order will be wrong." A forecast at o may use
 * only what was ingested by o.
 */

const MIN = 60_000;
const result = backtest(dataset);

describe('knowledge-time leakage: the forecast at o ignores events ingested after o', () => {
  it('is byte-identical with and without the later-ingested events at 5 origins (the report checks the same)', () => {
    expect(result.leakage.checks).toHaveLength(BACKTEST_DESIGN.leakageOrigins);
    expect(result.leakage.allIdentical).toBe(true);
    for (const c of result.leakage.checks) {
      const o = c.originMs;
      const trimmed: Dataset = knownDataset(dataset, o);
      expect(trimmed.events.length).toBeLessThan(dataset.events.length);
      expect(trimmed.events.every((e) => e.ingestedAt <= o)).toBe(true);
      const full = JSON.stringify(forecast(dataset, replay(dataset, o), o));
      const seen = JSON.stringify(forecast(trimmed, replay(trimmed, o), o));
      expect(seen, `origin ${new Date(o).toISOString()}`).toBe(full);
    }
  }, 60_000);

  it('removing later-ingested events does change the realized counts (so the check is not vacuous)', () => {
    const o = result.leakage.checks[0]?.originMs ?? 0;
    const trimmed = knownDataset(dataset, o);
    let full = 0;
    let seen = 0;
    for (const [h, times] of realizedArrivals(dataset)) {
      full += countIn(times, o, o + 60 * MIN);
      seen += countIn(realizedArrivals(trimmed).get(h) ?? [], o, o + 60 * MIN);
    }
    expect(full).toBeGreaterThan(seen);
  });
});

describe('determinism and shape', () => {
  it('backtest(dataset) is byte-identical on a second run', () => {
    expect(JSON.stringify(backtest(dataset))).toBe(JSON.stringify(result));
  }, 60_000);

  it('origins run every 15 min from dayStart + 120 to lastEvent - 60; pairs = origins x hospitals', () => {
    const d = result.design;
    expect(d.origins).toEqual(rollingOrigins(d.dayStartMs, d.lastEventMs));
    expect(d.origins[0]).toBe(d.dayStartMs + BACKTEST_DESIGN.firstOriginOffsetMin * MIN);
    for (let i = 1; i < d.origins.length; i++) expect((d.origins[i] ?? 0) - (d.origins[i - 1] ?? 0)).toBe(BACKTEST_DESIGN.originStepMin * MIN);
    expect(d.origins[d.origins.length - 1]).toBeLessThanOrEqual(d.lastEventMs - BACKTEST_DESIGN.lastOriginMarginMin * MIN);
    expect(d.originCount).toBeGreaterThan(10);
    expect(d.pairCount).toBe(d.originCount * dataset.hospitals.length);
    expect(result.pairs).toHaveLength(d.pairCount);
    expect(result.fits).toHaveLength(d.originCount);
    expect(result.schemaVersion).toBe('1.0');
    expect(JSON.stringify(result)).not.toMatch(/"generatedAt"|"timestamp"/);
  });

  it('metrics are finite, coverage and Brier lie in [0, 1], log scores are <= 0, reliability bins partition the pairs', () => {
    for (const id of MODEL_IDS) {
      const m = result.metrics[id];
      expect(m.n).toBe(result.design.pairCount);
      expect(Number.isFinite(m.mae)).toBe(true);
      expect(Number.isFinite(m.rps)).toBe(true);
      expect(Number.isFinite(m.logScore)).toBe(true);
      expect(m.mae).toBeGreaterThanOrEqual(0);
      expect(m.rps).toBeGreaterThanOrEqual(0);
      expect(m.logScore).toBeLessThanOrEqual(0);
      expect(m.coverage80).toBeGreaterThanOrEqual(0);
      expect(m.coverage80).toBeLessThanOrEqual(1);
      expect(m.brier).toBeGreaterThanOrEqual(0);
      expect(m.brier).toBeLessThanOrEqual(1);
      const bins = result.reliability[id];
      expect(bins).toHaveLength(BACKTEST_DESIGN.reliabilityBins);
      expect(bins.reduce((s, b) => s + b.n, 0)).toBe(result.design.pairCount);
      for (const b of bins) if (b.n > 0) {
        expect(b.meanPredicted).toBeGreaterThanOrEqual(b.lo - 1e-9);
        expect(b.meanPredicted).toBeLessThanOrEqual(b.hi + 1e-9);
        expect(b.observed).toBeGreaterThanOrEqual(0);
        expect(b.observed).toBeLessThanOrEqual(1);
      }
    }
    for (const p of result.pairs) {
      expect(p.p90Threshold === null ? false : p.realized > p.p90Threshold).toBe(p.spikeOutcome);
      for (const id of MODEL_IDS) {
        expect(p.models[id].pSpike).toBeGreaterThanOrEqual(0);
        expect(p.models[id].pSpike).toBeLessThanOrEqual(1);
        expect(p.models[id].p10).toBeLessThanOrEqual(p.models[id].p90);
      }
    }
    expect(result.skill.map((s) => s.vs)).toEqual(['M0', 'M1']);
  });

  it('first-warning onsets are real realized spikes with leads measured against earlier origins only', () => {
    for (const o of result.firstWarning.onsets) {
      expect(o.countAtOnset).toBeGreaterThan(o.p90);
      expect(o.trajectory.every((t) => t.originMs < o.onsetMs && t.pSpike >= 0 && t.pSpike <= 1)).toBe(true);
      if (o.firstWarningOriginMs !== null) {
        expect(o.firstWarningOriginMs).toBeLessThan(o.onsetMs);
        expect(o.leadMin).toBe(Math.round((o.onsetMs - o.firstWarningOriginMs) / MIN));
      }
      if (o.sustainedLeadMin !== null && o.leadMin !== null) expect(o.sustainedLeadMin).toBeLessThanOrEqual(o.leadMin);
    }
    expect(result.firstWarning.nWarned).toBeLessThanOrEqual(result.firstWarning.nWithOriginBefore);
  });
});

describe('scoring helpers', () => {
  it('a point mass on the realized count scores log 0, RPS 0 and is covered; a miss is penalised', () => {
    const sure = scorePmf(poissonPmf(0), 0);
    expect(sure.logScore).toBeCloseTo(0, 12);
    expect(sure.rps).toBeCloseTo(0, 12);
    expect(sure.covered).toBe(true);
    const miss = scorePmf(poissonPmf(0), 3);
    expect(miss.logScore).toBeCloseTo(Math.log(BACKTEST_DESIGN.logScoreFloor), 6);
    expect(miss.rps).toBeCloseTo(3, 9); // CDF is 1 at k = 0, 1, 2 while the outcome indicator is 0
    expect(miss.covered).toBe(false);
    // Realized beyond the PMF support is clamped rather than thrown.
    expect(Number.isFinite(scorePmf(poissonPmf(1), 1000).logScore)).toBe(true);
  });

  it('realized arrivals agree with the engine\'s end-of-day replay (one receivedMs per consult, per hospital)', () => {
    const maxIngested = dataset.events.reduce((m, e) => Math.max(m, e.ingestedAt), 0);
    const state = replay(dataset, maxIngested);
    const engine = new Map<string, number>();
    for (const c of Object.values(state.consults)) if (c.receivedMs !== null && c.hospitalId !== null) engine.set(c.hospitalId, (engine.get(c.hospitalId) ?? 0) + 1);
    for (const [h, times] of realizedArrivals(dataset)) expect(times.length, h).toBe(engine.get(h) ?? 0);
  });
});
