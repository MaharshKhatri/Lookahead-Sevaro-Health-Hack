import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffSnapshot, replay, toSnapshotConsultRows, toSnapshotPhysicianRows, type CellDiff } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et } from './helpers';

const dataset = loadDataset(DATA_DIR);
const diffAt = (mode: 'correct' | 'naive') => {
  const s = replay(dataset, et('18:20:00'), { mode });
  return diffSnapshot({ physicians: toSnapshotPhysicianRows(s), consults: toSnapshotConsultRows(s) }, dataset.snapshot!);
};

/**
 * Recorded from the actual naive run at 18:20 (40 cells, consult table only):
 * - CON-2107: the late video_started (event 18:11:20, ingested 18:18:05) is applied at ingestion,
 *   so stage_entered_at reads 18:18:05 and minutes_in_stage 1 instead of 8.
 * - Every other open consult: its stage-entering event is applied at ingested_at, 2-4 s after
 *   event_time, so stage_entered_at is off by that lag; where the shift crosses a whole minute
 *   relative to 18:20:00, the floored minutes_in_stage / minutes_since_received drop by one.
 * - Physicians: no diffs. By 18:20 the late event has arrived, and the duplicate EVT-00529
 *   (applied twice in naive mode) touches neither counts nor current state.
 */
const recorded = JSON.parse(readFileSync(fileURLToPath(new URL('./golden/naive_diffs_1820.json', import.meta.url)), 'utf8')) as CellDiff[];

describe('brief "Availability is inferred": "State built only from arrival order will be wrong"', () => {
  it('correct mode has no diffs', () => {
    expect(diffAt('correct').diffs).toEqual([]);
  });

  it('naive mode (arrival order, no dedupe, applied at ingested_at) produces the recorded diffs', () => {
    const naive = diffAt('naive');
    expect(naive.summary).toEqual({ physicians: '8/8 rows match', consults: '0/18 rows match' });
    expect(naive.diffs).toEqual(recorded);
  });

  it('includes the late-event correction for CON-2107', () => {
    expect(diffAt('naive').diffs.filter((d) => d.key === 'CON-2107')).toEqual([
      { table: 'consults', key: 'CON-2107', column: 'stage_entered_at', expected: '18:11:20', actual: '18:18:05' },
      { table: 'consults', key: 'CON-2107', column: 'minutes_in_stage', expected: '8', actual: '1' },
    ]);
  });

  it('every other stage_entered_at diff equals the ingestion lag of the stage-entering event (<= 4 s)', () => {
    const correct = replay(dataset, et('18:20:00'));
    for (const d of diffAt('naive').diffs.filter((x) => x.column === 'stage_entered_at' && x.key !== 'CON-2107')) {
      const entry = correct.consults[d.key]?.stageHistory.at(-1);
      const ev = dataset.events.find((e) => e.eventId === entry?.eventId);
      const shift = (Date.parse(`2026-03-17T${d.actual}-04:00`) - Date.parse(`2026-03-17T${d.expected}-04:00`)) / 1000;
      expect(ev, d.key).toBeDefined();
      expect(shift, d.key).toBe(((ev?.ingestedAt ?? 0) - (ev?.eventTime ?? 0)) / 1000);
      expect(shift, d.key).toBeLessThanOrEqual(4);
    }
  });

  it('naive mode applies the duplicate twice and warns about it', () => {
    const naive = replay(dataset, et('18:20:00'), { mode: 'naive' });
    expect(naive.integrity.appliedCount).toBe(1164);
    expect(naive.integrity.duplicates).toEqual([]);
    expect(naive.integrity.warnings.some((w) => w.startsWith('EVT-00529:'))).toBe(true);
  });
});
