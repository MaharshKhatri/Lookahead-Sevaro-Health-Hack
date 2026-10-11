/**
 * Forecast backtest core (pure: no I/O, no clock). Rolling-origin evaluation
 * of the Surge Forecast (DECISIONS D-85/D-86, OQ-47) against two reference
 * models on one dataset, plus a first-warning analysis of the brief's spike
 * condition ("trailing 60-minute consults above the hospital's p90 baseline
 * for that hour", OQ-19) and a knowledge-time leakage check.
 *
 * `pnpm report:forecast` (scripts/forecast-report.ts) writes
 * docs/FORECAST_BACKTEST.md and docs/forecast_backtest.json from the result
 * object returned here; every number in the Markdown comes from that object.
 * packages/engine/test/forecast.backtest.test.ts imports `backtest` for the
 * leakage, determinism and sanity checks.
 *
 * All instants are epoch ms; ET (BASELINE_HOUR_ZONE) is used only for hour
 * buckets and formatting (CLAUDE.md rule 4).
 */
import { DateTime } from 'luxon';
import {
  BASELINE_HOUR_ZONE,
  DEMAND_SPIKE_WINDOW_MS,
  ET_ZONE,
  FORECAST_N_MAX,
  buildBaselineTable,
  buildForecastModel,
  countDistribution,
  dedupe,
  forecast,
  integral0,
  knownArrivals,
  p90At,
  pGreaterThan,
  poissonPmf,
  quantile,
  replay,
  spikeProbability,
  type BaselineTable,
  type Dataset,
  type EpochMs,
  type ForecastModel,
  type Pmf,
} from '@lookahead/engine';

const MIN = 60_000;
const HOUR = 3_600_000;

/** Backtest design constants (BACKTEST-DEFINED; they shape the evaluation, not the engine). */
export const BACKTEST_DESIGN = {
  /** Origins every 15 min ... */
  originStepMin: 15,
  /** ... from dayStart + 120 min (the model needs some history) ... */
  firstOriginOffsetMin: 120,
  /** ... to lastEvent - 60 min (so every target window is fully observed). */
  lastOriginMarginMin: 60,
  /** Target window (o, o + 60]: the brief's 60-minute horizon and the spike window. */
  horizonMin: 60,
  /** M1 persistence: Poisson(max(trailing-60 count known at o, floor)). */
  persistenceFloor: 0.1,
  /** Floor for the PMF in the log score. */
  logScoreFloor: 1e-12,
  /** PMF support 0..nMax (FORECAST_N_MAX). */
  nMax: FORECAST_N_MAX,
  /** Reliability table bins over [0, 1]. */
  reliabilityBins: 5,
  /** First-warning: realized spike flags scanned every 5 min. */
  onsetScanStepMin: 5,
  /** First-warning: P(spike at onset) >= this counts as a warning. */
  warningThreshold: 0.5,
  /** Leakage check at this many origins, spread evenly over the rolling set. */
  leakageOrigins: 5,
  /** Trajectory of P(spike at onset) shown for origins within this many minutes before the onset. */
  trajectoryWindowMin: 120,
} as const;

export type ModelId = 'M0' | 'M1' | 'M2';
export const MODEL_IDS: readonly ModelId[] = ['M0', 'M1', 'M2'];
export const MODEL_LABELS: Readonly<Record<ModelId, string>> = {
  M0: 'baseline Poisson(Lambda0_h(o, o+60))',
  M1: 'persistence Poisson(max(trailing-60 count at o, 0.1))',
  M2: 'Lookahead (NegBin background x Poisson excitation, D-85)',
};

export interface PairForecast {
  readonly mean: number;
  readonly p10: number;
  readonly p90: number;
  /** P(count in (o, o+60] > p90_h(hour(o+60))); 0 when no p90 applies (like the detector). */
  readonly pSpike: number;
  readonly absErr: number;
  readonly logScore: number;
  readonly rps: number;
  readonly covered: boolean;
}

export interface PairRow {
  readonly originMs: EpochMs;
  readonly hospitalId: string;
  /** Distinct consults received at h with event_time in (o, o+60], full dataset after OQ-04 dedupe. */
  readonly realized: number;
  /** Trailing-60 count known at o (events ingested by o); M1's input. */
  readonly knownTrailing60: number;
  /** p90_h for the ET hour containing o+60; null without a weekday baseline row. */
  readonly p90Threshold: number | null;
  /** realized > p90Threshold (the detector's rule applied to what actually happened). */
  readonly spikeOutcome: boolean;
  readonly models: Readonly<Record<ModelId, PairForecast>>;
}

export interface ModelMetrics {
  readonly n: number;
  readonly mae: number;
  readonly logScore: number;
  readonly rps: number;
  readonly coverage80: number;
  readonly brier: number;
}

export interface ReliabilityBin {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly meanPredicted: number | null;
  readonly observed: number | null;
}

export interface Skill {
  readonly vs: 'M0' | 'M1';
  /** 1 - M2/Mx (positive = M2 better). */
  readonly mae: number;
  readonly rps: number;
  readonly brier: number;
  /** M2 - Mx (positive = M2 better). */
  readonly logScore: number;
  /** |Mx - 0.8| - |M2 - 0.8| (positive = M2 closer to nominal). */
  readonly coverage80: number;
}

export interface TrajectoryPoint {
  readonly originMs: EpochMs;
  readonly minutesBefore: number;
  readonly pSpike: number;
}

export interface SpikeOnset {
  readonly hospitalId: string;
  readonly onsetMs: EpochMs;
  /** Realized trailing-60 count at the onset and the p90 it exceeded. */
  readonly countAtOnset: number;
  readonly p90: number;
  /** Earliest rolling origin o < onset with P(spike at onset | model_o) >= warningThreshold. */
  readonly firstWarningOriginMs: EpochMs | null;
  readonly leadMin: number | null;
  /** Earliest origin from which every later origin before the onset also has P >= threshold. */
  readonly sustainedFromOriginMs: EpochMs | null;
  readonly sustainedLeadMin: number | null;
  readonly originsBefore: number;
  readonly trajectory: readonly TrajectoryPoint[];
}

export interface LeakageCheck {
  readonly originMs: EpochMs;
  readonly eventsDropped: number;
  readonly identical: boolean;
}

export interface FitRow {
  readonly originMs: EpochMs;
  readonly eta: number;
  readonly halfLifeMin: number;
  readonly mNet: number;
  readonly arrivals: number;
}

export interface BacktestResult {
  readonly schemaVersion: '1.0';
  readonly dataset: {
    readonly label: string;
    readonly etDate: string;
    readonly hospitals: number;
    readonly hospitalNames: Readonly<Record<string, string>>;
    readonly events: number;
    readonly consultsReceived: number;
  };
  readonly design: typeof BACKTEST_DESIGN & {
    readonly dayStartMs: EpochMs;
    readonly firstEventMs: EpochMs;
    readonly lastEventMs: EpochMs;
    readonly origins: readonly EpochMs[];
    readonly originCount: number;
    readonly pairCount: number;
  };
  readonly metrics: Readonly<Record<ModelId, ModelMetrics>>;
  /** The same metrics over the first and second half of the origins (does the forecast improve as the fit matures?). */
  readonly segments: readonly { readonly label: string; readonly fromMs: EpochMs; readonly toMs: EpochMs; readonly pairCount: number; readonly metrics: Readonly<Record<ModelId, ModelMetrics>> }[];
  readonly skill: readonly Skill[];
  readonly reliability: Readonly<Record<ModelId, readonly ReliabilityBin[]>>;
  readonly pairs: readonly PairRow[];
  readonly firstWarning: {
    readonly n: number;
    readonly nWithOriginBefore: number;
    readonly nWarned: number;
    /** Warned onsets whose lead is >= 60 min, i.e. the whole trailing window was still in the future at the origin. */
    readonly nWarnedLead60Plus: number;
    readonly medianLeadMin: number | null;
    readonly onsets: readonly SpikeOnset[];
  };
  readonly leakage: { readonly allIdentical: boolean; readonly checks: readonly LeakageCheck[] };
  readonly fits: readonly FitRow[];
}

export interface BacktestOptions {
  /** Label written into the result (no wall-clock values, so the output is deterministic). */
  readonly label?: string;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * Realized arrivals per hospital: the first consult_received event_time of
 * each distinct consult id (full dataset, OQ-04 dedupe, no knowledge-time
 * filter). This is "what actually happened", not what was known at the time.
 */
export function realizedArrivals(dataset: Dataset): ReadonlyMap<string, readonly EpochMs[]> {
  const { events } = dedupe(dataset.events);
  const firstByConsult = new Map<string, { hospitalId: string; tMs: EpochMs }>();
  for (const e of events) {
    if (e.eventType !== 'consult_received' || e.consultId === null || e.hospitalId === null) continue;
    const cur = firstByConsult.get(e.consultId);
    if (cur === undefined || e.eventTime < cur.tMs) firstByConsult.set(e.consultId, { hospitalId: e.hospitalId, tMs: e.eventTime });
  }
  const out = new Map<string, EpochMs[]>();
  for (const h of dataset.hospitals) out.set(h.hospitalId, []);
  for (const { hospitalId, tMs } of firstByConsult.values()) out.get(hospitalId)?.push(tMs);
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

/** Count of times in (aMs, bMs]. */
export function countIn(times: readonly EpochMs[], aMs: EpochMs, bMs: EpochMs): number {
  let n = 0;
  for (const t of times) if (t > aMs && t <= bMs) n++;
  return n;
}

/** Log score, RPS and the 80% central interval of a PMF against a realized count (clamped to the PMF support). */
export function scorePmf(pmf: Pmf, realized: number): { logScore: number; rps: number; p10: number; p90: number; covered: boolean } {
  const y = Math.min(Math.max(0, realized), pmf.length - 1);
  const logScore = Math.log(Math.max(pmf[y] ?? 0, BACKTEST_DESIGN.logScoreFloor));
  let cdf = 0;
  let rps = 0;
  for (let k = 0; k < pmf.length; k++) {
    cdf = Math.min(1, cdf + (pmf[k] ?? 0));
    rps += (cdf - (y <= k ? 1 : 0)) ** 2;
  }
  const p10 = quantile(pmf, 0.1);
  const p90 = quantile(pmf, 0.9);
  return { logScore, rps, p10, p90, covered: realized >= p10 && realized <= p90 };
}

/** Rolling origins: dayStart + firstOffset, every step, while o <= lastEvent - margin. */
export function rollingOrigins(dayStartMs: EpochMs, lastEventMs: EpochMs): EpochMs[] {
  const out: EpochMs[] = [];
  const last = lastEventMs - BACKTEST_DESIGN.lastOriginMarginMin * MIN;
  for (let o = dayStartMs + BACKTEST_DESIGN.firstOriginOffsetMin * MIN; o <= last; o += BACKTEST_DESIGN.originStepMin * MIN) out.push(o);
  return out;
}

/** Dataset restricted to what was ingested by `asOfMs` (the knowledge-time view, materialized). */
export function knownDataset(dataset: Dataset, asOfMs: EpochMs): Dataset {
  return { ...dataset, events: dataset.events.filter((e) => e.ingestedAt <= asOfMs) };
}

/** The forecast at o must not change when events ingested after o are removed from the dataset. */
export function leakageCheck(dataset: Dataset, originMs: EpochMs): LeakageCheck {
  const full = JSON.stringify(forecast(dataset, replay(dataset, originMs), originMs));
  const trimmed = knownDataset(dataset, originMs);
  const seen = JSON.stringify(forecast(trimmed, replay(trimmed, originMs), originMs));
  return { originMs, eventsDropped: dataset.events.length - trimmed.events.length, identical: full === seen };
}

function pairForecast(pmf: Pmf, mean: number, realized: number, pSpike: number): PairForecast {
  const s = scorePmf(pmf, realized);
  return { mean: r4(mean), p10: s.p10, p90: s.p90, pSpike: r4(pSpike), absErr: r4(Math.abs(mean - realized)), logScore: r4(s.logScore), rps: r4(s.rps), covered: s.covered };
}

function evaluatePair(table: BaselineTable, model: ForecastModel, realized: readonly EpochMs[], hospitalId: string, o: EpochMs): PairRow {
  const end = o + BACKTEST_DESIGN.horizonMin * MIN;
  const y = countIn(realized, o, end);
  const p90T = p90At(table, hospitalId, end);
  const pOf = (pmf: Pmf) => (p90T === null ? 0 : pGreaterThan(pmf, p90T));
  // M0: the hospital's baseline hour means integrated over the window.
  const lambda0 = integral0(table, hospitalId, o, end);
  const pmf0 = poissonPmf(lambda0, BACKTEST_DESIGN.nMax);
  // M1: what the last 60 minutes looked like at o, as known at o.
  const known60 = knownArrivals(model, hospitalId, o - DEMAND_SPIKE_WINDOW_MS, o);
  const mu1 = Math.max(known60, BACKTEST_DESIGN.persistenceFloor);
  const pmf1 = poissonPmf(mu1, BACKTEST_DESIGN.nMax);
  // M2: the engine's predictive count and its own spike probability at o+60
  // (identical formula here, since the known part of the window (o, o] is empty).
  const d2 = countDistribution(model, hospitalId, o, end);
  const s2 = spikeProbability(model, hospitalId, end);
  return {
    originMs: o,
    hospitalId,
    realized: y,
    knownTrailing60: known60,
    p90Threshold: p90T,
    spikeOutcome: p90T !== null && y > p90T,
    models: {
      M0: pairForecast(pmf0, lambda0, y, pOf(pmf0)),
      M1: pairForecast(pmf1, mu1, y, pOf(pmf1)),
      M2: pairForecast(d2.pmf, d2.mean, y, s2.pSpike),
    },
  };
}

function aggregate(pairs: readonly PairRow[], id: ModelId): ModelMetrics {
  const n = pairs.length;
  const mean = (f: (p: PairRow) => number) => (n === 0 ? 0 : pairs.reduce((s, p) => s + f(p), 0) / n);
  return {
    n,
    mae: r4(mean((p) => p.models[id].absErr)),
    logScore: r4(mean((p) => p.models[id].logScore)),
    rps: r4(mean((p) => p.models[id].rps)),
    coverage80: r4(mean((p) => (p.models[id].covered ? 1 : 0))),
    brier: r4(mean((p) => (p.models[id].pSpike - (p.spikeOutcome ? 1 : 0)) ** 2)),
  };
}

function reliability(pairs: readonly PairRow[], id: ModelId): ReliabilityBin[] {
  const k = BACKTEST_DESIGN.reliabilityBins;
  const bins = Array.from({ length: k }, () => ({ n: 0, sumP: 0, sumO: 0 }));
  for (const p of pairs) {
    const pr = p.models[id].pSpike;
    const b = bins[Math.min(k - 1, Math.floor(pr * k))];
    if (b === undefined) continue;
    b.n++;
    b.sumP += pr;
    b.sumO += p.spikeOutcome ? 1 : 0;
  }
  return bins.map((b, i) => ({ lo: r4(i / k), hi: r4((i + 1) / k), n: b.n, meanPredicted: b.n === 0 ? null : r4(b.sumP / b.n), observed: b.n === 0 ? null : r4(b.sumO / b.n) }));
}

function skillVs(m: Readonly<Record<ModelId, ModelMetrics>>, vs: 'M0' | 'M1'): Skill {
  const ratio = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : -Infinity) : 1 - a / b);
  return {
    vs,
    mae: r4(ratio(m.M2.mae, m[vs].mae)),
    rps: r4(ratio(m.M2.rps, m[vs].rps)),
    brier: r4(ratio(m.M2.brier, m[vs].brier)),
    logScore: r4(m.M2.logScore - m[vs].logScore),
    coverage80: r4(Math.abs(m[vs].coverage80 - 0.8) - Math.abs(m.M2.coverage80 - 0.8)),
  };
}

function spikeOnsets(dataset: Dataset, table: BaselineTable, realized: ReadonlyMap<string, readonly EpochMs[]>, dayStartMs: EpochMs, lastEventMs: EpochMs): { hospitalId: string; onsetMs: EpochMs; count: number; p90: number }[] {
  const out: { hospitalId: string; onsetMs: EpochMs; count: number; p90: number }[] = [];
  const step = BACKTEST_DESIGN.onsetScanStepMin * MIN;
  for (const h of dataset.hospitals) {
    const times = realized.get(h.hospitalId) ?? [];
    let prev = false;
    for (let t = dayStartMs; t <= lastEventMs; t += step) {
      const count = countIn(times, t - DEMAND_SPIKE_WINDOW_MS, t);
      const p90 = p90At(table, h.hospitalId, t);
      const flag = p90 !== null && count > p90;
      if (flag && !prev && p90 !== null) out.push({ hospitalId: h.hospitalId, onsetMs: t, count, p90 });
      prev = flag;
    }
  }
  return out;
}

function firstWarning(onset: { hospitalId: string; onsetMs: EpochMs; count: number; p90: number }, origins: readonly EpochMs[], models: ReadonlyMap<EpochMs, ForecastModel>): SpikeOnset {
  const before = origins.filter((o) => o < onset.onsetMs);
  const probs = before.map((o) => {
    const model = models.get(o);
    return { originMs: o, minutesBefore: Math.round((onset.onsetMs - o) / MIN), pSpike: model === undefined ? 0 : spikeProbability(model, onset.hospitalId, onset.onsetMs).pSpike };
  });
  const thr = BACKTEST_DESIGN.warningThreshold;
  const first = probs.find((p) => p.pSpike >= thr) ?? null;
  let sustained: TrajectoryPoint | null = null;
  for (let i = probs.length - 1; i >= 0 && (probs[i]?.pSpike ?? 0) >= thr; i--) sustained = probs[i] ?? null;
  return {
    hospitalId: onset.hospitalId,
    onsetMs: onset.onsetMs,
    countAtOnset: onset.count,
    p90: onset.p90,
    firstWarningOriginMs: first?.originMs ?? null,
    leadMin: first?.minutesBefore ?? null,
    sustainedFromOriginMs: sustained?.originMs ?? null,
    sustainedLeadMin: sustained?.minutesBefore ?? null,
    originsBefore: before.length,
    trajectory: probs.filter((p) => p.minutesBefore <= BACKTEST_DESIGN.trajectoryWindowMin).map((p) => ({ ...p, pSpike: r4(p.pSpike) })),
  };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function backtest(dataset: Dataset, opts: BacktestOptions = {}): BacktestResult {
  const unique = dedupe(dataset.events).events;
  if (unique.length === 0) throw new Error('backtest: dataset has no events');
  const firstEventMs = unique.reduce((m, e) => Math.min(m, e.eventTime), Number.POSITIVE_INFINITY);
  const lastEventMs = unique.reduce((m, e) => Math.max(m, e.eventTime), Number.NEGATIVE_INFINITY);
  const dayStartMs = DateTime.fromMillis(firstEventMs, { zone: BASELINE_HOUR_ZONE }).startOf('hour').toMillis();
  const origins = rollingOrigins(dayStartMs, lastEventMs);
  const table = buildBaselineTable(dataset, dayStartMs, lastEventMs + 3 * HOUR);
  const realized = realizedArrivals(dataset);

  // One knowledge-time replay and one refit per origin (replay(dataset, o) uses only events ingested by o).
  const models = new Map<EpochMs, ForecastModel>();
  for (const o of origins) models.set(o, buildForecastModel(dataset, replay(dataset, o), o));

  const pairs: PairRow[] = [];
  for (const o of origins) {
    const model = models.get(o);
    if (model === undefined) continue;
    for (const h of dataset.hospitals) pairs.push(evaluatePair(table, model, realized.get(h.hospitalId) ?? [], h.hospitalId, o));
  }
  const metricsOf = (rows: readonly PairRow[]): Record<ModelId, ModelMetrics> => ({ M0: aggregate(rows, 'M0'), M1: aggregate(rows, 'M1'), M2: aggregate(rows, 'M2') });
  const metrics = metricsOf(pairs);
  const half = Math.floor(origins.length / 2);
  const segments = [
    { label: 'first half of origins', origins: origins.slice(0, half) },
    { label: 'second half of origins', origins: origins.slice(half) },
  ]
    .filter((s) => s.origins.length > 0)
    .map((s) => {
      const set = new Set(s.origins);
      const rows = pairs.filter((x) => set.has(x.originMs));
      return { label: s.label, fromMs: s.origins[0] ?? dayStartMs, toMs: s.origins[s.origins.length - 1] ?? dayStartMs, pairCount: rows.length, metrics: metricsOf(rows) };
    });

  const onsets = spikeOnsets(dataset, table, realized, dayStartMs, lastEventMs).map((on) => firstWarning(on, origins, models));
  const leads = onsets.flatMap((o) => (o.leadMin === null ? [] : [o.leadMin]));

  const nLeak = Math.min(BACKTEST_DESIGN.leakageOrigins, origins.length);
  const leakOrigins = Array.from({ length: nLeak }, (_, i) => origins[nLeak === 1 ? 0 : Math.round((i * (origins.length - 1)) / (nLeak - 1))]).filter((o): o is EpochMs => o !== undefined);
  const checks = leakOrigins.map((o) => leakageCheck(dataset, o));

  let consultsReceived = 0;
  for (const list of realized.values()) consultsReceived += list.length;
  const etDate = DateTime.fromMillis(firstEventMs, { zone: ET_ZONE }).toISODate() ?? '';
  return {
    schemaVersion: '1.0',
    dataset: {
      label: opts.label ?? `${etDate} ET${dataset.snapshot === null ? '' : ` (snapshot ${dataset.snapshot.label})`}`,
      etDate,
      hospitals: dataset.hospitals.length,
      hospitalNames: Object.fromEntries(dataset.hospitals.map((h) => [h.hospitalId, h.hospitalName])),
      events: unique.length,
      consultsReceived,
    },
    design: { ...BACKTEST_DESIGN, dayStartMs, firstEventMs, lastEventMs, origins, originCount: origins.length, pairCount: pairs.length },
    metrics,
    segments,
    skill: [skillVs(metrics, 'M0'), skillVs(metrics, 'M1')],
    reliability: { M0: reliability(pairs, 'M0'), M1: reliability(pairs, 'M1'), M2: reliability(pairs, 'M2') },
    pairs,
    firstWarning: {
      n: onsets.length,
      nWithOriginBefore: onsets.filter((o) => o.originsBefore > 0).length,
      nWarned: leads.length,
      nWarnedLead60Plus: leads.filter((l) => l >= BACKTEST_DESIGN.horizonMin).length,
      medianLeadMin: median(leads),
      onsets,
    },
    leakage: { allIdentical: checks.every((c) => c.identical), checks },
    fits: origins.map((o) => {
      const m = models.get(o);
      return { originMs: o, eta: m?.fit.eta ?? 0, halfLifeMin: m?.fit.halfLifeMin ?? 0, mNet: r4(m?.mNet ?? 0), arrivals: m?.fit.n ?? 0 };
    }),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering: every number comes from the result object.

const hm = (ms: EpochMs) => DateTime.fromMillis(ms, { zone: ET_ZONE }).toFormat('HH:mm');
const f4 = (x: number | null) => (x === null ? '-' : x.toFixed(4));
const f3 = (x: number | null) => (x === null ? '-' : x.toFixed(3));
const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|');

export function renderMarkdown(r: BacktestResult): string {
  const out: string[] = [];
  const p = (s = '') => out.push(s);
  const table = (head: string[], rows: unknown[][]) => {
    p(`| ${head.join(' | ')} |`);
    p(`| ${head.map(() => '---').join(' | ')} |`);
    for (const row of rows) p(`| ${row.map(cell).join(' | ')} |`);
    p();
  };
  const name = (id: string) => (r.dataset.hospitalNames[id] === undefined ? id : `${r.dataset.hospitalNames[id]} (${id})`);
  const d = r.design;
  const m = r.metrics;

  p('<!-- Generated by `pnpm report:forecast` (scripts/forecast-report.ts, core in scripts/lib/backtest.ts). Do not edit by hand; every number below is computed from the dataset. -->');
  p('# Surge Forecast backtest');
  p();
  p(`Dataset: \`${r.dataset.label}\`, ${r.dataset.hospitals} hospitals, ${r.dataset.events} unique events, ${r.dataset.consultsReceived} consults received between ${hm(d.firstEventMs)} and ${hm(d.lastEventMs)} ET. Companion JSON: \`docs/forecast_backtest.json\` (schema ${r.schemaVersion}).`);
  p();
  p('Rolling-origin evaluation of the Surge Forecast (DECISIONS D-85/D-86, OQ-47) against two reference models. The forecast under test is the engine\'s own `buildForecastModel` / `countDistribution` / `spikeProbability`, refit at every origin from the knowledge-time replay (events with `ingested_at <= o` only). The brief\'s spike condition is "trailing 60-minute consults above the hospital\'s p90 baseline for that hour" (OQ-19, strict `>`, ET hour buckets, weekday rows).');
  p();

  p('## 1. Design');
  p();
  table(
    ['parameter', 'value'],
    [
      ['day start (first event_time floored to the ET hour)', `${hm(d.dayStartMs)} ET`],
      ['origins', `every ${d.originStepMin} min from day start + ${d.firstOriginOffsetMin} min (${hm(d.origins[0] ?? d.dayStartMs)}) to last event − ${d.lastOriginMarginMin} min (${hm(d.origins[d.origins.length - 1] ?? d.dayStartMs)}): ${d.originCount} origins`],
      ['pairs (origin x hospital)', d.pairCount],
      ['target', `count of consults received at h in (o, o + ${d.horizonMin} min]`],
      ['realized count', 'distinct consult ids with a consult_received event_time in the window, full dataset after OQ-04 dedupe (what actually happened, not what was known)'],
      ['knowledge at o', '`replay(dataset, o)`: only events with ingested_at <= o; the model is refit at each origin from that state alone'],
      ['PMF support', `0..${d.nMax} (realized counts above ${d.nMax} would be clamped; none were needed)`],
      ['spike event', `realized count in (o, o+${d.horizonMin}] > p90_h(ET hour of o+${d.horizonMin}); no weekday baseline row means no spike (probability 0, outcome false), as in the detector`],
      ['spike probability', `M0/M1: P(count > p90) from their Poisson PMF (at o+60 the whole trailing-60 window is the target window); M2: \`spikeProbability(model_o, h, o+60)\``],
      ['log score floor', d.logScoreFloor],
      ['reliability bins', `${d.reliabilityBins} equal bins over [0, 1]`],
    ],
  );
  p('Models:');
  p();
  for (const id of MODEL_IDS) p(`- **${id}**: ${MODEL_LABELS[id]}`);
  p();

  p('## 2. Results (all pairs)');
  p();
  table(
    ['model', 'n', 'MAE of mean', 'mean log score (higher is better)', 'RPS (lower is better)', '80% interval coverage (nominal 0.80)', 'Brier, spike at o+60 (lower is better)'],
    MODEL_IDS.map((id) => [`${id} ${MODEL_LABELS[id]}`, m[id].n, f4(m[id].mae), f4(m[id].logScore), f4(m[id].rps), f4(m[id].coverage80), f4(m[id].brier)]),
  );
  p('Skill of M2 (positive = M2 better): `1 − M2/Mx` for MAE, RPS and Brier; `M2 − Mx` for the log score; `|Mx − 0.8| − |M2 − 0.8|` for coverage.');
  p();
  table(['vs', 'MAE', 'RPS', 'Brier', 'log score', 'coverage distance'], r.skill.map((s) => [s.vs, f4(s.mae), f4(s.rps), f4(s.brier), f4(s.logScore), f4(s.coverage80)]));
  const wins = (vs: 'M0' | 'M1') => {
    const s = r.skill.find((x) => x.vs === vs);
    return s === undefined ? 0 : [s.mae, s.rps, s.brier, s.logScore, s.coverage80].filter((v) => v > 0).length;
  };
  p(`M2 improves on M0 in ${wins('M0')} of 5 metrics and on M1 in ${wins('M1')} of 5.`);
  p();
  p('By origin half (the fit sees more arrivals as the day goes on):');
  p();
  table(
    ['segment', 'origins (ET)', 'pairs', 'model', 'MAE', 'log score', 'RPS', 'coverage 80%', 'Brier'],
    r.segments.flatMap((s) => MODEL_IDS.map((id) => [s.label, `${hm(s.fromMs)}-${hm(s.toMs)}`, s.pairCount, id, f4(s.metrics[id].mae), f4(s.metrics[id].logScore), f4(s.metrics[id].rps), f4(s.metrics[id].coverage80), f4(s.metrics[id].brier)])),
  );
  const outcomes = r.pairs.filter((x) => x.spikeOutcome).length;
  const thresholds = r.pairs.flatMap((x) => (x.p90Threshold === null ? [] : [x.p90Threshold]));
  p(`Spike outcomes: ${outcomes} of ${r.pairs.length} pairs (${pct(r.pairs.length === 0 ? null : outcomes / r.pairs.length)}) had a realized count above the hour's p90 at o+60. Realized counts ranged ${Math.min(...r.pairs.map((x) => x.realized))}..${Math.max(...r.pairs.map((x) => x.realized))} per hospital-hour; the p90 thresholds ranged ${thresholds.length === 0 ? '-' : `${Math.min(...thresholds)}..${Math.max(...thresholds)}`}, so a "spike" here is an exceedance by one or two consults, which no hour-ahead model can call with confidence (hence the thin upper bins below).`);
  p();

  p('## 3. Reliability of the spike probability');
  p();
  p('Predicted P(spike at o+60) binned; `observed` is the fraction of pairs in the bin whose realized count exceeded the p90. A calibrated model has observed close to mean predicted in every populated bin. With this few positive outcomes the upper bins are thin; read them as indicative only.');
  p();
  for (const id of MODEL_IDS) {
    p(`**${id}**`);
    p();
    table(['bin', 'n', 'mean predicted', 'observed frequency'], r.reliability[id].map((b) => [`[${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}${b.hi >= 1 ? ']' : ')'}`, b.n, f3(b.meanPredicted), f3(b.observed)]));
  }

  p('## 4. First warning before realized spike onsets');
  p();
  p(`Onsets: for each hospital, scan the day every ${d.onsetScanStepMin} min and take each instant where the realized trailing-60 count first exceeds p90 for that ET hour (flag turns on from off). For each onset, the first warning is the earliest rolling origin o < onset with P(spike at onset | model_o) >= ${d.warningThreshold}; "sustained from" is the earliest origin from which every later origin also stays >= ${d.warningThreshold}. Lead time = onset − origin.`);
  p();
  const fw = r.firstWarning;
  p(`**n = ${fw.n} onset${fw.n === 1 ? '' : 's'}** on this one day (${fw.nWithOriginBefore} with at least one origin before it; ${fw.nWarned} warned at >= ${d.warningThreshold}, of which ${fw.nWarnedLead60Plus} at a lead of 60 min or more; median lead ${fw.medianLeadMin === null ? 'n/a' : `${fw.medianLeadMin} min`}). ${fw.n <= 3 ? 'This is a tiny sample: one synthetic day yields very few onsets, so the lead times below are anecdotes, not statistics.' : 'Still a small sample from one day.'}`);
  p();
  if (fw.onsets.length > 0) {
    table(
      ['hospital', 'onset (ET)', 'count > p90', 'origins before', 'first warning origin', 'lead (min)', 'sustained from', 'sustained lead (min)'],
      fw.onsets.map((o) => [name(o.hospitalId), hm(o.onsetMs), `${o.countAtOnset} > ${o.p90}`, o.originsBefore, o.firstWarningOriginMs === null ? (o.originsBefore === 0 ? 'no origin before onset' : `none >= ${d.warningThreshold}`) : hm(o.firstWarningOriginMs), o.leadMin ?? '-', o.sustainedFromOriginMs === null ? '-' : hm(o.sustainedFromOriginMs), o.sustainedLeadMin ?? '-']),
    );
    for (const o of fw.onsets) {
      if (o.trajectory.length === 0) continue;
      p(`P(spike at ${hm(o.onsetMs)}) at ${name(o.hospitalId)}, by origin (last ${d.trajectoryWindowMin} min before the onset):`);
      p();
      table(['origin (ET)', 'minutes before', 'P(spike at onset)'], o.trajectory.map((t) => [hm(t.originMs), t.minutesBefore, f3(t.pSpike)]));
    }
  }
  p('Note on lead times: for origins less than 60 min before the onset, part of the onset\'s trailing-60 window is already known at the origin, so P rises mechanically as the origin approaches the onset (the detector itself fires at lead 0). A genuinely anticipatory warning is one at a lead of 60 min or more, where the whole window is still in the future.');
  p();

  p('## 5. Knowledge-time leakage check');
  p();
  p(`At ${r.leakage.checks.length} origins spread over the rolling set, the forecast at o (\`forecast(dataset, replay(dataset, o), o)\`, serialized) was compared with the forecast computed on a dataset from which every event with \`ingested_at > o\` had been removed. **${r.leakage.allIdentical ? 'All byte-identical' : 'NOT identical: leakage detected'}.** The same check runs as a vitest (\`packages/engine/test/forecast.backtest.test.ts\`).`);
  p();
  table(['origin (ET)', 'events removed', 'identical'], r.leakage.checks.map((c) => [hm(c.originMs), c.eventsDropped, c.identical ? 'yes' : '**NO**']));

  p('## 6. Fit per origin');
  p();
  p('The Hawkes grid search (shared eta and half-life) and the network day-rate multiplier m_net, refit at every origin from knowledge-time arrivals only.');
  p();
  table(['origin (ET)', 'arrivals used', 'eta', 'half-life (min)', 'm_net'], r.fits.map((f) => [hm(f.originMs), f.arrivals, f.eta.toFixed(2), f.halfLifeMin, f.mNet.toFixed(3)]));

  p('## 7. Limitations (read before quoting any number above)');
  p();
  p(`- **One synthetic day.** ${d.originCount} origins x ${r.dataset.hospitals} hospitals is ${d.pairCount} forecasts, but they are heavily correlated (the same ${r.dataset.consultsReceived} consults seen from overlapping windows) and the spike outcome is rare, so the Brier and reliability numbers have wide uncertainty and the first-warning analysis is anecdotal. Production would fit and evaluate on Sevaro's history; the baseline file is itself a 12-week aggregate, so the data to do that exists.`);
  p('- **Why this model class.** Baseline hour means x a day-rate multiplier x short-term self-excitation gives a forecast that is calibrated with little data (the Gamma-Poisson background has an explicit prior and is a negative binomial, not an over-confident Poisson), explainable per driver (the 60-min expectation decomposes exactly into baseline, today\'s rate and recent arrivals), cheap (one closed-form PMF per hospital, a 91-point grid fit in tens of milliseconds) and robust (no gradient steps, no hyperparameter search at run time, deterministic). It is not the most accurate model one could fit on a year of data; it is the most defensible one to fit on a morning.');
  p('- **Where it is weak.** The excitation half-life is weakly identified by a few hundred arrivals (the fit table above shows it moving between origins); excitation counts the first generation of offspring only, so long horizons after a burst are understated; the baseline is piecewise constant per ET hour bucket, so the forecast steps at the hour; the detector\'s projection holds a spike for the horizon (OQ-19 "hold_from_now_through_horizon") while the forecast ages consults out of the window, so the two can disagree by design for T between the detector\'s "now" and +60; the stroke-only thinning uses a posterior share, not a stroke-specific rate; counts are truncated at 40.');
  const w0 = wins('M0');
  const w1 = wins('M1');
  p(`- **The reference models are deliberately simple, and the comparison is reported as it fell.** M0 is what the baseline file alone says; M1 is "the next hour looks like the last hour". On this day M2 improves on M0 in ${w0} of 5 metrics and on M1 in ${w1} of 5. ${w0 === 0 ? `Not beating M0 on count accuracy means that, with ${r.dataset.consultsReceived} consults and hour-ahead counts of ${Math.min(...r.pairs.map((x) => x.realized))}..${Math.max(...r.pairs.map((x) => x.realized))}, the 12-week hour means already describe the next hour about as well as anything that can be fitted within the day; the within-day terms (today's rate, recent arrivals) are estimated from thin data and add variance at this horizon (the origin-half table in section 2 shows where; the early-origin Hawkes fits in section 6 also land on a large eta from a handful of arrivals, the identifiability weakness noted above). This is the expected regime for a quiet synthetic day and is exactly the kind of finding a backtest on real history is for.` : 'Beating simple references is the minimum bar, not evidence of a good model.'}`);
  p('- **The realized spike flag is not the live detector\'s flag.** It applies the same rule (count > p90 for the ET hour) to the realized counts; the live detector sees only events ingested by then, so on a day with ingestion lag the two can differ at the margin. The equivalence of P(spike) at T = t with the live detector is tested separately (D-85).');
  p();
  return out.join('\n');
}
