import { expect, inject } from 'vitest';

/**
 * Timing thresholds (DECISIONS D-28, D-41, D-52, D-62). Each limit is the
 * isolated-run target and is enforced exactly when vitest runs one worker
 * (e.g. `--no-file-parallelism` or `--maxWorkers=1`). With more than one
 * worker, other test files share the CPU, so the limit is relaxed by
 * PARALLEL_FACTOR (still a gross-regression guard). LOOKAHEAD_SKIP_BENCH=1
 * prints the timings and enforces nothing.
 */
export const PARALLEL_FACTOR = 3;

export type BenchMode = 'isolated' | 'parallel' | 'skipped';

export function benchMode(): BenchMode {
  if (process.env.LOOKAHEAD_SKIP_BENCH === '1') return 'skipped';
  return inject('benchWorkers') > 1 ? 'parallel' : 'isolated';
}

/** Asserts `ms < isolatedLimitMs` (x PARALLEL_FACTOR under parallel load); logs which limit applied. */
export function expectWithinBudget(label: string, ms: number, isolatedLimitMs: number): void {
  const mode = benchMode();
  if (mode === 'skipped') {
    console.log(`LOOKAHEAD_SKIP_BENCH=1: ${label} threshold not enforced`);
    return;
  }
  const limit = mode === 'parallel' ? isolatedLimitMs * PARALLEL_FACTOR : isolatedLimitMs;
  console.log(`${label}: ${ms.toFixed(1)} ms vs limit ${limit} ms (${mode}, ${inject('benchWorkers')} worker(s))`);
  expect(ms, `${label} (${mode})`).toBeLessThan(limit);
}
