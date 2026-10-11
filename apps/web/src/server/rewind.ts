import 'server-only';
import * as engine from '@lookahead/engine';
import type { RewindReportDTO } from '@/lib/dto';
import type { StoreSnapshot } from './store';

/**
 * /rewind: the engine's counterfactual replay (Phase 5, `rewind(dataset, nowMs)`).
 * The export is checked at runtime so the web layer builds whether or not the
 * engine module has landed; without it the route answers 503 NOT_READY and
 * the page shows an honest empty state. Cached per (bootId, datasetVersion,
 * minute): the report depends only on the dataset and the reference instant.
 */

type RewindFn = (dataset: engine.Dataset, nowMs: number) => RewindReportDTO;

export function rewindAvailable(): boolean {
  return typeof (engine as unknown as { rewind?: unknown }).rewind === 'function';
}

const memo: { key: string; report: RewindReportDTO }[] = [];

export function rewindFor(s: StoreSnapshot): RewindReportDTO | null {
  const fn = (engine as unknown as { rewind?: RewindFn }).rewind;
  if (fn === undefined) return null;
  const nowMs = s.snapshotMs;
  const key = `${s.bootId}|${s.datasetVersion}|${Math.floor(nowMs / 60_000)}`;
  const hit = memo.find((m) => m.key === key);
  if (hit !== undefined) return hit.report;
  const report = fn(s.dataset, nowMs);
  const names = Object.fromEntries(s.dataset.hospitals.map((h) => [h.hospitalId, h.hospitalName]));
  const out: RewindReportDTO = { ...report, hospitalNames: names };
  memo.unshift({ key, report: out });
  memo.length = Math.min(memo.length, 2);
  return out;
}
