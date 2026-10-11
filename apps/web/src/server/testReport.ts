import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths';

/**
 * The last REAL test run (sprint A4/A6): `pnpm test:report` runs vitest in
 * both packages with the JSON reporter and writes docs/test-report.json.
 * Pages show its counts and timestamp; when the file is absent they say so
 * (never a static green badge).
 */
export interface SuiteSummary {
  readonly files: number;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs: number;
}

export interface TestReport {
  readonly schemaVersion: '1.0';
  readonly generatedAtMs: number;
  readonly command: string;
  readonly suites: Readonly<Record<'engine' | 'web', SuiteSummary>>;
  readonly total: SuiteSummary;
  readonly ok: boolean;
}

export const TEST_REPORT_FILE = 'docs/test-report.json';

export function readTestReport(file = process.env.LOOKAHEAD_TEST_REPORT_FILE ?? join(repoRoot(), TEST_REPORT_FILE)): TestReport | null {
  if (!existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as TestReport;
    return r.schemaVersion === '1.0' && typeof r.generatedAtMs === 'number' ? r : null;
  } catch {
    return null;
  }
}
