import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths';

/**
 * /quality reads the forecast backtest written by `pnpm report:forecast`
 * (docs/forecast_backtest.json, D-89). Every number on the page comes from
 * this file; nothing is typed in the app. Null when the report was not generated.
 */

export interface BacktestMetrics {
  readonly n: number;
  readonly mae: number;
  readonly logScore: number;
  readonly rps: number;
  readonly coverage80: number;
  readonly brier: number;
}

export interface BacktestReport {
  readonly schemaVersion: string;
  readonly dataset: { readonly label: string; readonly hospitals: number; readonly events: number; readonly consultsReceived: number; readonly etDate: string; readonly hospitalNames: Readonly<Record<string, string>> };
  readonly design: { readonly originCount: number; readonly pairCount: number; readonly originStepMin: number; readonly horizonMin: number; readonly warningThreshold: number; readonly reliabilityBins: number; readonly origins: readonly number[] };
  readonly metrics: Readonly<Record<string, BacktestMetrics>>;
  readonly skill: readonly { readonly vs: string; readonly mae: number; readonly rps: number; readonly brier: number; readonly logScore: number; readonly coverage80: number }[];
  readonly reliability: Readonly<Record<string, readonly { readonly lo: number; readonly hi: number; readonly n: number; readonly meanPredicted: number; readonly observed: number }[]>>;
  readonly firstWarning: { readonly n: number; readonly nWarned: number; readonly nWarnedLead60Plus: number; readonly nWithOriginBefore: number; readonly medianLeadMin: number | null; readonly onsets: readonly { readonly hospitalId: string; readonly onsetMs: number; readonly countAtOnset: number; readonly p90: number; readonly leadMin: number | null; readonly firstWarningOriginMs: number | null; readonly originsBefore: number }[] };
  readonly leakage: { readonly allIdentical: boolean; readonly checks: readonly { readonly originMs: number; readonly eventsDropped: number; readonly identical: boolean }[] };
  readonly segments: readonly { readonly label: string; readonly fromMs: number; readonly toMs: number; readonly pairCount: number; readonly metrics: Readonly<Record<string, BacktestMetrics>> }[];
  readonly fits: readonly { readonly originMs: number; readonly eta: number; readonly halfLifeMin: number; readonly mNet: number; readonly arrivals: number }[];
}

export const BACKTEST_FILE = (): string => process.env.LOOKAHEAD_BACKTEST_FILE ?? join(repoRoot(), 'docs', 'forecast_backtest.json');

export function readBacktest(): BacktestReport | null {
  const file = BACKTEST_FILE();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BacktestReport;
  } catch {
    return null;
  }
}
