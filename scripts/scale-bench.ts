/**
 * `pnpm scale:bench [factor=20] [dataDir=data/raw] [out=docs/SCALE.md]`
 *
 * Scale benchmark (D-92): clones the Sevaro package `factor` times with
 * remapped ids (PHY/SYN/CON/EVT numbers offset per clone, names suffixed) and
 * seeded jitter on event_time (mulberry32, 0..90 s either way, never after
 * ingested_at), parses it with the engine's parseDataset and times every
 * stage at the reference instant: ingest/parse, replay, detect, decide,
 * forecast (buildForecastModel + forecast), standby (planWithLog on an empty
 * log) and incidents (buildIncidents) when the engine exports it. Each stage
 * runs 3 times; the table reports the median. The numbers are measured on the
 * machine that runs the script and written to docs/SCALE.md, never typed in.
 *
 * `--json --quick` (sprint B3, the live scale test behind POST /api/scale-test):
 * one run per stage, the two composite stages (forecast cold, full recompute)
 * skipped because they only re-time stages already measured, no docs write;
 * progress lines `@@progress {"phase","stage"}` go to stderr before each stage
 * and one JSON result line goes to stdout. The default mode is unchanged.
 *
 * The clone ids are synthetic benchmark data, not Sevaro ids (CLAUDE.md rule 2
 * applies to the engine, which here only sees a well-formed package).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as engine from '@lookahead/engine';
import { DATASET_FILES, buildForecastModel, decide, detect, forecast, mulberry32, parseDataset, planWithLog, replay, snapshotAsOfMs, type Dataset } from '@lookahead/engine';

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const JSON_MODE = flags.has('--json');
const QUICK = flags.has('--quick');
const factor = Math.max(1, Number(positional[0] ?? '20') || 20);
const dataDir = positional[1] ?? 'data/raw';
const outPath = positional[2] ?? 'docs/SCALE.md';
const SEED = 20260317;
const JITTER_MAX_S = 90;
const REPEATS = QUICK ? 1 : 3;

/** Stage progress for the parent process (live scale test): which stage is about to run, so a timeout can say how far it got. */
let phase = 'clone';
function progress(stage: string): void {
  if (JSON_MODE) process.stderr.write(`@@progress ${JSON.stringify({ phase, stage })}\n`);
}

// ------------------------------------------------------------------ cloning

const ID_RE = /\b(PHY|SYN|CON|EVT)-(\d+)\b/g;
/** Per-clone offsets large enough that clone ids never collide with the original or each other. */
const OFFSET: Readonly<Record<string, number>> = { PHY: 1_000, SYN: 1_000, CON: 100_000, EVT: 1_000_000 };

function remapIds(text: string, clone: number): string {
  if (clone === 0) return text;
  return text.replace(ID_RE, (_m, prefix: string, digits: string) => `${prefix}-${String(Number(digits) + clone * (OFFSET[prefix] ?? 1_000)).padStart(digits.length, '0')}`);
}

/** Suffixes hospital and physician display names so clones are distinguishable (names are not keys). */
function suffixNames(text: string, clone: number, file: string): string {
  if (clone === 0) return text;
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? '';
  const cols = header.split(',');
  const nameCols = cols.map((c, i) => (c === 'name' || c === 'hospital_name' ? i : -1)).filter((i) => i >= 0);
  if (nameCols.length === 0 || file === DATASET_FILES.events) return text;
  return [
    header,
    ...lines.slice(1).map((l) => {
      if (l.trim() === '') return l;
      const cells = l.split(',');
      for (const i of nameCols) if (cells[i] !== undefined && cells[i] !== '') cells[i] = `${cells[i]} #${clone}`;
      return cells.join(',');
    }),
  ].join('\n');
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?([+-]\d{2}:\d{2}|Z)$/;

function isoToMs(s: string): { ms: number; offset: string } | null {
  const m = ISO_RE.exec(s);
  if (m === null) return null;
  const [, y, mo, d, h, mi, se, frac, off] = m;
  const offMin = off === 'Z' ? 0 : (off?.startsWith('-') ? -1 : 1) * (Number(off?.slice(1, 3)) * 60 + Number(off?.slice(4, 6)));
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)) + Math.round(Number(frac ?? '0') * 1000) - offMin * 60_000;
  return { ms, offset: off ?? 'Z' };
}

function msToIso(ms: number, offset: string): string {
  const offMin = offset === 'Z' ? 0 : (offset.startsWith('-') ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = new Date(ms + offMin * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}${offset}`;
}

/** Jitters event_time by a seeded 0..90 s in either direction, clamped so event_time <= ingested_at. */
function jitterEvents(text: string, clone: number): string {
  if (clone === 0) return text;
  const rng = mulberry32(SEED + clone);
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? '';
  const cols = header.split(',');
  const iEvent = cols.indexOf('event_time');
  const iIngested = cols.indexOf('ingested_at');
  if (iEvent < 0 || iIngested < 0) throw new Error(`event_stream.csv header lacks event_time/ingested_at: ${header}`);
  return [
    header,
    ...lines.slice(1).map((l) => {
      if (l.trim() === '') return l;
      const cells = l.split(',');
      const ev = isoToMs(cells[iEvent] ?? '');
      const ing = isoToMs(cells[iIngested] ?? '');
      if (ev === null || ing === null) return l;
      const sign = rng.next() < 0.5 ? -1 : 1;
      const jitter = sign * Math.floor(rng.next() * (JITTER_MAX_S + 1)) * 1000;
      cells[iEvent] = msToIso(Math.min(ev.ms + jitter, ing.ms), ev.offset);
      return cells.join(',');
    }),
  ].join('\n');
}

function cloneTexts(dir: string, clones: number): Record<string, string> {
  const files = readdirSync(dir).filter((n) => n.endsWith('.csv'));
  const out: Record<string, string> = {};
  for (const file of files) {
    const original = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    const lines = original.split('\n');
    const header = lines[0] ?? '';
    const body = lines.slice(1).filter((l) => l.trim() !== '');
    const parts: string[] = [];
    for (let k = 0; k < clones; k++) {
      let text = `${header}\n${body.join('\n')}\n`;
      text = remapIds(text, k);
      text = suffixNames(text, k, file);
      if (file === DATASET_FILES.events) text = jitterEvents(text, k);
      const rows = text.split('\n').slice(1).filter((l) => l.trim() !== '');
      parts.push(...rows);
    }
    if (file === DATASET_FILES.credentials) {
      // Block-diagonal credentialing: each clone's physicians are credentialed only at that clone's hospitals.
      const hospitalCols = header.split(',').slice(2);
      const allCols = Array.from({ length: clones }, (_, k) => hospitalCols.map((h) => remapIds(h, k))).flat();
      const rows: string[] = [];
      for (let k = 0; k < clones; k++) {
        const block = remapIds(`${header}\n${body.join('\n')}`, k).split('\n').slice(1);
        for (const r of block) {
          const cells = r.split(',');
          const id = cells[0] ?? '';
          const name = suffixNames(`name\n${cells[1] ?? ''}`, k, file).split('\n')[1] ?? '';
          const flags = cells.slice(2);
          const full = allCols.map((_c, i) => (Math.floor(i / hospitalCols.length) === k ? (flags[i % hospitalCols.length] ?? '') : ''));
          rows.push([id, name, ...full].join(','));
        }
      }
      out[file] = `${['physician_id', 'name', ...allCols].join(',')}\n${rows.join('\n')}\n`;
      continue;
    }
    out[file] = `${header}\n${parts.join('\n')}\n`;
  }
  return out;
}

// ------------------------------------------------------------------ timing

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function timed<T>(fn: () => T, stage = ''): { ms: number[]; value: T } {
  if (stage !== '') progress(stage);
  const ms: number[] = [];
  let value!: T;
  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now();
    value = fn();
    ms.push(performance.now() - t0);
  }
  return { ms, value };
}

interface Row {
  readonly stage: string;
  readonly medianMs: number;
  readonly runsMs: readonly number[];
  readonly notes: string;
}

function bench(texts: Record<string, string>): { rows: Row[]; dataset: Dataset; nowMs: number } {
  const rows: Row[] = [];
  const parse = timed(() => parseDataset(texts), 'ingest/parse');
  const dataset = parse.value;
  const nowMs = snapshotAsOfMs(dataset) ?? Math.max(...dataset.events.map((e) => e.ingestedAt));
  rows.push({ stage: 'ingest/parse', medianMs: median(parse.ms), runsMs: parse.ms, notes: `${dataset.events.length} events, ${dataset.hospitals.length} hospitals, ${dataset.warnings.length} warnings` });

  const rep = timed(() => replay(dataset, nowMs), 'replay');
  rows.push({ stage: 'replay', medianMs: median(rep.ms), runsMs: rep.ms, notes: `${Object.keys(rep.value.physicians).length} physician states, ${Object.keys(rep.value.consults).length} consult states` });

  const det = timed(() => detect(dataset, nowMs), 'detect');
  rows.push({ stage: 'detect', medianMs: median(det.ms), runsMs: det.ms, notes: `${det.value.attention.length} attention items, ${det.value.staffing.hospitals.length} hospitals projected` });

  const dec = timed(() => decide(dataset, nowMs), 'decide');
  rows.push({ stage: 'decide', medianMs: median(dec.ms), runsMs: dec.ms, notes: `${dec.value.needs.length} needs, ${dec.value.ledger.length} ledger rows (includes its own detect)` });

  const state = rep.value;
  const fit = timed(() => buildForecastModel(dataset, state, nowMs), 'forecast fit (buildForecastModel)');
  rows.push({ stage: 'forecast fit (buildForecastModel)', medianMs: median(fit.ms), runsMs: fit.ms, notes: `Hawkes grid search over ${fit.value.fit.n} arrivals` });
  const fc = timed(() => forecast(dataset, state, nowMs, { fit: fit.value.fit }), 'forecast (with memoized fit)');
  rows.push({ stage: 'forecast (with memoized fit)', medianMs: median(fc.ms), runsMs: fc.ms, notes: `${fc.value.hospitals.length} hospital forecasts` });
  if (!QUICK) {
    const fcCold = timed(() => forecast(dataset, state, nowMs));
    rows.push({ stage: 'forecast (cold, refits)', medianMs: median(fcCold.ms), runsMs: fcCold.ms, notes: 'fit + forecast as the first call per minute does it' });
  }

  const sb = timed(() => planWithLog({ dataset, forecastFit: fit.value.fit }, [], nowMs), 'standby (planWithLog, empty log, memoized fit)');
  rows.push({ stage: 'standby (planWithLog, empty log, memoized fit)', medianMs: median(sb.ms), runsMs: sb.ms, notes: `${sb.value.plan.cells.length} grid cells, ${sb.value.plan.candidates.length} candidates, ${sb.value.plan.selected.length} selected (includes its own decide)` });

  const buildIncidents = (engine as Record<string, unknown>).buildIncidents as ((input: unknown) => unknown[]) | undefined;
  if (typeof buildIncidents === 'function') {
    const inc = timed(() => buildIncidents({ dataset, decision: sb.value.decision, forecast: fc.value, plan: sb.value.plan, log: [], nowMs }), 'incidents (buildIncidents)');
    rows.push({ stage: 'incidents (buildIncidents)', medianMs: median(inc.ms), runsMs: inc.ms, notes: `${inc.value.length} incidents from ${sb.value.decision.detection.attention.length} attention items` });
  } else {
    rows.push({ stage: 'incidents', medianMs: NaN, runsMs: [], notes: 'not yet exported by the engine at run time' });
  }

  if (QUICK) return { rows, dataset, nowMs };
  const full = timed(() => {
    const d = decide(dataset, nowMs);
    const st = replay(dataset, nowMs);
    const m = buildForecastModel(dataset, st, nowMs);
    const f = forecast(dataset, st, nowMs, { fit: m.fit });
    const p = planWithLog({ dataset, forecastFit: m.fit }, [], nowMs);
    return { d, f, p };
  });
  rows.push({ stage: 'full recompute (decide + replay + fit + forecast + standby)', medianMs: median(full.ms), runsMs: full.ms, notes: 'what one /api/view miss costs before memoization' });
  return { rows, dataset, nowMs };
}

// ------------------------------------------------------------------ main

const t0 = performance.now();
progress('clone');
const texts = cloneTexts(dataDir, factor);
const cloneMs = performance.now() - t0;
phase = 'x1';
const baseline = bench(Object.fromEntries(readdirSync(dataDir).filter((n) => n.endsWith('.csv')).map((n) => [n, readFileSync(join(dataDir, n), 'utf8')])));
phase = `x${factor}`;
const scaled = bench(texts);

const uniquePhysicians = (d: Dataset) => new Set([...d.physiciansOnShift.map((p) => p.physicianId), ...d.offShiftRoster.map((p) => p.physicianId), ...d.credentials.map((p) => p.physicianId)]).size;

if (JSON_MODE) {
  // One line of JSON on stdout; NaN (stage not exported) becomes null. Nothing is written to docs/.
  const pack = (b: ReturnType<typeof bench>) => ({
    hospitals: b.dataset.hospitals.length,
    physicians: uniquePhysicians(b.dataset),
    events: b.dataset.events.length,
    nowMs: b.nowMs,
    rows: b.rows.map((r) => ({ stage: r.stage, medianMs: Number.isNaN(r.medianMs) ? null : r.medianMs, runsMs: r.runsMs, notes: r.notes })),
  });
  const result = {
    schemaVersion: '1.0',
    factor,
    repeats: REPEATS,
    quick: QUICK,
    cloneMs,
    machine: { cpu: cpus()[0]?.model ?? 'unknown CPU', cores: cpus().length, memGb: Math.round(totalmem() / 1e9), node: process.version },
    baseline: pack(baseline),
    scaled: pack(scaled),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

const fmt = (ms: number) => (Number.isNaN(ms) ? 'n/a' : ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));
const table = (rows: Row[]) => ['| Stage | Median ms (of 3) | Runs (ms) | Notes |', '|---|---:|---|---|', ...rows.map((r) => `| ${r.stage} | ${fmt(r.medianMs)} | ${r.runsMs.map(fmt).join(' / ')} | ${r.notes} |`)].join('\n');

const ds = scaled.dataset;
const physicians = new Set([...ds.physiciansOnShift.map((p) => p.physicianId), ...ds.offShiftRoster.map((p) => p.physicianId), ...ds.credentials.map((p) => p.physicianId)]).size;
const fullScaled = scaled.rows.find((r) => r.stage.startsWith('full recompute'))?.medianMs ?? NaN;

const md = `# Scale benchmark

Generated by \`pnpm scale:bench ${factor}\` (scripts/scale-bench.ts, D-92). Every number below was measured on the machine that ran the script; nothing is typed in.

- Machine: ${cpus()[0]?.model ?? 'unknown CPU'} x${cpus().length}, ${Math.round(totalmem() / 1e9)} GB RAM, Node ${process.version}.
- Reference package (${dataDir}): ${baseline.dataset.hospitals.length} hospitals, ${new Set([...baseline.dataset.physiciansOnShift.map((p) => p.physicianId), ...baseline.dataset.offShiftRoster.map((p) => p.physicianId), ...baseline.dataset.credentials.map((p) => p.physicianId)]).size} physicians, ${baseline.dataset.events.length} events.
- Scaled package (x${factor}): ${ds.hospitals.length} hospitals, ${physicians} physicians, ${ds.events.length} events, ${ds.credentials.length} credentialing rows (block-diagonal: a clone's physicians are credentialed only at that clone's hospitals). Cloning took ${cloneMs.toFixed(0)} ms. Event times jittered by a seeded 0..${JITTER_MAX_S} s (mulberry32 seed ${SEED}), never after ingested_at.
- "now" is the snapshot instant of the package (18:20 ET), ${REPEATS} runs per stage, median reported.

## x${factor} package

${table(scaled.rows)}

## x1 reference package (same machine, same run)

${table(baseline.rows)}

## Reading the numbers

- A full recompute at x${factor} takes **${fmt(fullScaled)} ms** (median). ${Number.isNaN(fullScaled) ? '' : fullScaled > 1000 ? 'That is over the 1 s budget for an interactive view; see the hotspot notes below.' : 'That is under the 1 s budget for one /api/view miss; the web layer memoizes the view per (store version, minute) and the Hawkes fit per (dataset version, minute), so the steady-state cost per SSE refresh is one decide + plan, not a refit.'}
- The costs that grow with hospitals x physicians are the routability matrix in detect (every on-shift physician against every hospital at each projection point) and the standby gap grid (cells = hospitals x 12 quarter-hours, each with a spike-probability lookup). Both are linear in hospitals for a fixed roster per hospital because credentialing is block-diagonal in this clone; a network where every physician covers every hospital would be quadratic.
- The Hawkes fit is a 13 x 7 grid search over all arrivals of the day; it scales with the event count and is memoized per minute in the web layer (apps/web/src/server/forecast.ts), so only the first view of each sim minute pays it.

## Hotspots and proposed fixes (not applied unless noted)

1. **Fit per minute, not per view**: already memoized (D-85); the "forecast (cold, refits)" row above is what an un-memoized call would cost.
2. **detect inside decide inside planWithLog**: planWithLog recomputes decide (which recomputes detect) on every call. A view miss already shares one DecisionReport between the DTOs (apps/web/src/server/view.ts), so the duplicate shows up only in this benchmark's "full recompute" row (decide once standalone and once inside planWithLog). A pure memo of detect(dataset, nowMs, acceptedOffers) keyed by (dataset identity, nowMs, accepted ids) would remove it; not applied, since it is not on the live path.
3. **Projection points**: coverage projection runs per hospital per 5-min step over the horizon; at x${factor} this is the largest single term inside detect. Vectorizing the per-step staffed count per hospital (one pass over shifts into a per-hospital timeline, then slice) would make it O(hospitals x steps) instead of O(hospitals x steps x physicians). Pure refactor, no behavior change; left as a proposal because it touches brief-defined projection code frozen by the golden tests.
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md);
console.log(table(scaled.rows));
console.log(`\nx${factor}: ${ds.hospitals.length} hospitals, ${physicians} physicians, ${ds.events.length} events; wrote ${outPath}${existsSync(outPath) ? '' : ' (write failed?)'}`);
