/**
 * `pnpm test:report` (sprint A4/A6, D-97): runs the engine and web vitest
 * suites with the JSON reporter and writes docs/test-report.json, the file
 * /architecture and the status modal read. The counts are whatever the run
 * produced; a failing run is written too (ok: false) and the script exits 1.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface VitestJson {
  readonly numTotalTests: number;
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests?: number;
  readonly startTime: number;
  readonly testResults: readonly { readonly endTime?: number }[];
}

interface SuiteSummary {
  readonly files: number;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs: number;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs', 'test-report.json');
const tmp = mkdtempSync(join(tmpdir(), 'lookahead-test-report-'));

function run(name: 'engine' | 'web', dir: string): SuiteSummary {
  const file = join(tmp, `${name}.json`);
  const started = Date.now();
  const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${file}`], { cwd: join(ROOT, dir), stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  let j: VitestJson;
  try {
    j = JSON.parse(readFileSync(file, 'utf8')) as VitestJson;
  } catch {
    console.error(`[test-report] ${name}: vitest wrote no JSON report (exit ${r.status ?? 'signal'})`);
    return { files: 0, tests: 0, passed: 0, failed: 1, skipped: 0, durationMs: Date.now() - started };
  }
  return {
    files: j.testResults.length,
    tests: j.numTotalTests,
    passed: j.numPassedTests,
    failed: j.numFailedTests,
    skipped: j.numPendingTests + (j.numTodoTests ?? 0),
    durationMs: Date.now() - started,
  };
}

const engine = run('engine', 'packages/engine');
const web = run('web', 'apps/web');
const sum = (k: keyof SuiteSummary) => engine[k] + web[k];
const total: SuiteSummary = { files: sum('files'), tests: sum('tests'), passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped'), durationMs: sum('durationMs') };
const report = {
  schemaVersion: '1.0' as const,
  generatedAtMs: Date.now(),
  command: 'pnpm test:report (vitest run, engine + web)',
  suites: { engine, web },
  total,
  ok: total.failed === 0 && total.tests > 0,
};
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[test-report] engine ${engine.passed}/${engine.tests}, web ${web.passed}/${web.tests}, failed ${total.failed}; wrote ${OUT}`);
process.exit(report.ok ? 0 : 1);
