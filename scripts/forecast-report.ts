/**
 * `pnpm report:forecast [dataDir] [mdOut] [jsonOut]`: rolling-origin backtest
 * of the Surge Forecast (D-85/D-86, OQ-47) against baseline and persistence
 * reference models, with calibration, first-warning lead times and a
 * knowledge-time leakage check. Writes docs/FORECAST_BACKTEST.md and
 * docs/forecast_backtest.json. The core (`backtest`) lives in
 * scripts/lib/backtest.ts and is imported by the engine's vitest; this file
 * only loads the data and writes the files. Every number in the Markdown is
 * rendered from the result object; nothing is hand-typed, and the output
 * carries no wall-clock timestamp so it is byte-stable across runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadDataset } from '@lookahead/engine/loaders';
import { backtest, renderMarkdown, MODEL_IDS } from './lib/backtest';
import { stableJson } from './lib/freeze';

const dataDir = process.argv[2] ?? 'data/raw';
const mdPath = process.argv[3] ?? 'docs/FORECAST_BACKTEST.md';
const jsonPath = process.argv[4] ?? 'docs/forecast_backtest.json';

const t0 = performance.now();
const dataset = loadDataset(dataDir);
const result = backtest(dataset, { label: `${dataDir} (${dataset.snapshot === null ? 'no snapshot' : `snapshot ${dataset.snapshot.label}`})` });
const elapsedMs = Math.round(performance.now() - t0);

for (const path of [mdPath, jsonPath]) mkdirSync(dirname(path), { recursive: true });
writeFileSync(mdPath, renderMarkdown(result));
writeFileSync(jsonPath, `${stableJson(result)}\n`);

console.log(`origins ${result.design.originCount}, pairs ${result.design.pairCount}, onsets ${result.firstWarning.n}, leakage ${result.leakage.allIdentical ? 'clean' : 'DETECTED'} (${elapsedMs} ms)`);
console.log(['model', 'MAE', 'logScore', 'RPS', 'cov80', 'Brier'].join('\t'));
for (const id of MODEL_IDS) {
  const m = result.metrics[id];
  console.log([id, m.mae.toFixed(4), m.logScore.toFixed(4), m.rps.toFixed(4), m.coverage80.toFixed(4), m.brier.toFixed(4)].join('\t'));
}
console.log(`wrote ${mdPath} and ${jsonPath}`);
