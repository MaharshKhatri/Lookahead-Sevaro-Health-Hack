import { detect, type AttentionItem, type DetectionReport, type StandardEvaluation } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et } from './helpers';

export const dataset = loadDataset(DATA_DIR);
let cached: DetectionReport | null = null;
/** The 18:20 detection report, computed once per test file. */
export function report1820(): DetectionReport {
  cached ??= detect(dataset, et('18:20:00'));
  return cached;
}

export const clock = (ms: number) => new Date(ms - 4 * 3_600_000).toISOString().slice(11, 19);

/** Compact, stable view of a standards evaluation for golden files. */
export const breachRow = (s: StandardEvaluation) => ({
  consultId: s.consultId,
  consultType: s.consultType,
  standard: s.standard,
  level: s.level,
  clockStart: clock(s.clockStartMs),
  elapsedMin: Math.round((s.elapsedMs / 60_000) * 100) / 100,
  warnAt: clock(s.warnAtMs),
  criticalAt: clock(s.criticalAtMs),
});

export const itemRow = (a: AttentionItem) => ({ id: a.id, kind: a.kind, severity: a.severity, score: a.score, headline: a.headline });
