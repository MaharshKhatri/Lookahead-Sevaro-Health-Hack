import 'server-only';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir, repoRoot } from './paths';

/**
 * Live scale test (sprint B3, LOOKAHEAD-DEFINED): runs scripts/scale-bench.ts
 * in `--json --quick` mode in a CHILD PROCESS (node + the tsx loader), so the
 * benchmark never touches the live store or its event loop. One run at a time
 * (BUSY otherwise), a hard timeout (SCALE_TEST_TIMEOUT_MS, default 30 s) that
 * kills the child and reports the stage it was in, and an honest 503 when the
 * tsx loader or the script is not present at runtime. Every number returned
 * was measured by the child on this machine.
 */

export const SCALE_TEST_DEFAULT_FACTOR = 20;
export const SCALE_TEST_MAX_FACTOR = 40;
export const SCALE_TEST_DEFAULT_TIMEOUT_MS = 30_000;
/** A stage is "interactive" only if measured under this budget (the page claims "under 1 s" from this test alone). */
export const INTERACTIVE_BUDGET_MS = 1_000;

export interface BenchRow {
  readonly stage: string;
  readonly medianMs: number | null;
  readonly runsMs: readonly number[];
  readonly notes: string;
}

export interface BenchPack {
  readonly hospitals: number;
  readonly physicians: number;
  readonly events: number;
  readonly nowMs: number;
  readonly rows: readonly BenchRow[];
}

export interface BenchJson {
  readonly schemaVersion: '1.0';
  readonly factor: number;
  readonly repeats: number;
  readonly quick: boolean;
  readonly cloneMs: number;
  readonly machine: { readonly cpu: string; readonly cores: number; readonly memGb: number; readonly node: string };
  readonly baseline: BenchPack;
  readonly scaled: BenchPack;
}

export interface StageComparison {
  readonly stage: string;
  readonly x1Ms: number | null;
  readonly xNMs: number | null;
  /** xN / x1, null when either side is missing or x1 is 0. */
  readonly ratio: number | null;
  readonly underBudget: boolean | null;
  readonly sentence: string;
}

export interface ScaleTestOk {
  readonly ok: true;
  readonly factor: number;
  readonly elapsedMs: number;
  readonly bench: BenchJson;
  readonly stages: readonly StageComparison[];
  readonly summary: string;
}

export interface ScaleTestFailure {
  readonly ok: false;
  readonly code: 'BUSY' | 'TIMEOUT' | 'UNAVAILABLE' | 'BENCH_FAILED' | 'BAD_REQUEST';
  readonly status: 409 | 504 | 503 | 500 | 400;
  readonly message: string;
  readonly phase: string | null;
  readonly stage: string | null;
  readonly stagesStarted: number;
  readonly elapsedMs: number;
}

export type ScaleTestResult = ScaleTestOk | ScaleTestFailure;

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms >= 100 ? ms.toFixed(0) : ms.toFixed(1)} ms`);

/** Pure: pairs x1 and xN rows by stage and words each result from the measured value only. */
export function compareStages(bench: BenchJson): StageComparison[] {
  const base = new Map(bench.baseline.rows.map((r) => [r.stage, r.medianMs]));
  return bench.scaled.rows.map((r) => {
    const x1 = base.get(r.stage) ?? null;
    const xN = r.medianMs;
    const ratio = x1 !== null && xN !== null && x1 > 0 ? xN / x1 : null;
    const underBudget = xN === null ? null : xN < INTERACTIVE_BUDGET_MS;
    const sentence =
      xN === null
        ? `${r.stage}: not measured (${r.notes}).`
        : `${r.stage} at x${bench.factor}: ${fmtMs(xN)}${underBudget ? ', under 1 s' : ', over 1 s'}${x1 === null ? '' : ` (x1: ${fmtMs(x1)}${ratio === null ? '' : `, ${ratio.toFixed(1)}x`})`}.`;
    return { stage: r.stage, x1Ms: x1, xNMs: xN, ratio, underBudget, sentence };
  });
}

export function summarize(bench: BenchJson, stages: readonly StageComparison[]): string {
  const measured = stages.filter((s) => s.xNMs !== null);
  const under = measured.filter((s) => s.underBudget === true);
  const slowest = [...measured].sort((a, b) => (b.xNMs ?? 0) - (a.xNMs ?? 0))[0];
  const head = `x${bench.factor}: ${bench.scaled.hospitals} hospitals, ${bench.scaled.physicians} physicians, ${bench.scaled.events} events (x1: ${bench.baseline.hospitals} / ${bench.baseline.physicians} / ${bench.baseline.events}). ${bench.repeats} run${bench.repeats === 1 ? '' : 's'} per stage.`;
  const budget = `${under.length} of ${measured.length} measured stages ran under 1 s at x${bench.factor}${under.length === measured.length ? '' : `; slowest: ${slowest?.stage ?? 'n/a'} at ${slowest?.xNMs === null || slowest === undefined ? 'n/a' : fmtMs(slowest.xNMs)}`}.`;
  return `${head} ${budget}`;
}

let running = false;

export const scaleTestRunning = (): boolean => running;

export function parseFactor(raw: string | null): number | null {
  if (raw === null || raw === '') return SCALE_TEST_DEFAULT_FACTOR;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= SCALE_TEST_MAX_FACTOR ? n : null;
}

export function timeoutMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number(env.SCALE_TEST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : SCALE_TEST_DEFAULT_TIMEOUT_MS;
}

/** The tsx ESM loader and the bench script; SCALE_TEST_TSX_LOADER overrides the loader path (tests use it to prove the 503). */
export function benchPaths(env: Readonly<Record<string, string | undefined>> = process.env): { readonly loader: string; readonly script: string; readonly root: string } {
  const root = repoRoot();
  return { root, loader: env.SCALE_TEST_TSX_LOADER ?? join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs'), script: join(root, 'scripts', 'scale-bench.ts') };
}

const fail = (code: ScaleTestFailure['code'], status: ScaleTestFailure['status'], message: string, extra: Partial<ScaleTestFailure> = {}): ScaleTestFailure => ({
  ok: false,
  code,
  status,
  message,
  phase: null,
  stage: null,
  stagesStarted: 0,
  elapsedMs: 0,
  ...extra,
});

export async function runScaleTest(factor: number, limitMs: number = timeoutMs()): Promise<ScaleTestResult> {
  if (running) return fail('BUSY', 409, 'a scale test is already running; one at a time');
  const { loader, script, root } = benchPaths();
  if (!existsSync(loader)) return fail('UNAVAILABLE', 503, `the tsx loader is not installed at runtime (${loader.startsWith(root) ? loader.slice(root.length + 1) : loader}); the live scale test needs it to run scripts/scale-bench.ts. Run \`pnpm scale:bench\` from a checkout instead.`);
  if (!existsSync(script)) return fail('UNAVAILABLE', 503, 'scripts/scale-bench.ts is not present in this deployment; the live scale test cannot run here.');
  running = true;
  const t0 = performance.now();
  try {
    return await new Promise<ScaleTestResult>((resolve) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, script, '--json', '--quick', String(factor), dataDir()], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderrTail = '';
      let last: { phase: string; stage: string } | null = null;
      let started = 0;
      let settled = false;
      const done = (r: ScaleTestResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        const where = last === null ? 'before the first stage started' : `in ${last.phase}, stage "${last.stage}"`;
        done(fail('TIMEOUT', 504, `scale test x${factor} exceeded ${limitMs} ms ${where} (${started} stages started); the child process was killed. Nothing in the live store was touched.`, { phase: last?.phase ?? null, stage: last?.stage ?? null, stagesStarted: started, elapsedMs: performance.now() - t0 }));
      }, limitMs);
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString('utf8');
      });
      child.stderr.on('data', (b: Buffer) => {
        const text = b.toString('utf8');
        for (const line of text.split('\n')) {
          const m = /^@@progress (.*)$/.exec(line.trim());
          if (m === null) continue;
          try {
            last = JSON.parse(m[1] ?? '') as { phase: string; stage: string };
            started++;
          } catch {
            // partial line; the next chunk carries the next stage
          }
        }
        stderrTail = (stderrTail + text.replace(/^@@progress .*$/gm, '')).slice(-800);
      });
      child.on('error', (e) => done(fail('BENCH_FAILED', 500, `could not start the bench process: ${e.message}`, { elapsedMs: performance.now() - t0 })));
      child.on('close', (code) => {
        const elapsedMs = performance.now() - t0;
        if (code !== 0) {
          done(fail('BENCH_FAILED', 500, `bench process exited with code ${String(code)}: ${stderrTail.trim() || 'no output'}`, { phase: last?.phase ?? null, stage: last?.stage ?? null, stagesStarted: started, elapsedMs }));
          return;
        }
        try {
          const bench = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as BenchJson;
          const stages = compareStages(bench);
          done({ ok: true, factor, elapsedMs, bench, stages, summary: summarize(bench, stages) });
        } catch (e) {
          done(fail('BENCH_FAILED', 500, `bench output was not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { stagesStarted: started, elapsedMs }));
        }
      });
    });
  } finally {
    running = false;
  }
}
