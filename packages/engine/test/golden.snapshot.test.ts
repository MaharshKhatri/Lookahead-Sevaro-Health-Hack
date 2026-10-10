import { describe, expect, it } from 'vitest';
import { diffSnapshot, replay, snapshotAsOfMs, toSnapshotConsultRows, toSnapshotPhysicianRows } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et } from './helpers';

const dataset = loadDataset(DATA_DIR);

describe('brief "What Teams Must Demonstrate" #1: rebuild current state from the event stream and match the reference snapshot', () => {
  it('reference "now" is 18:20:00 ET (brief "Synthetic Dataset")', () => {
    expect(snapshotAsOfMs(dataset)).toBe(et('18:20:00'));
  });

  it('correct-mode replay at 18:20 reproduces both snapshot files cell for cell (8/8 physicians, 18/18 consults)', () => {
    const state = replay(dataset, et('18:20:00'));
    const result = diffSnapshot({ physicians: toSnapshotPhysicianRows(state), consults: toSnapshotConsultRows(state) }, dataset.snapshot!);
    expect(result.diffs).toEqual([]);
    expect(result.summary).toEqual({ physicians: '8/8 rows match', consults: '18/18 rows match' });
  });

  it('applies every unique event with no reducer warnings', () => {
    const state = replay(dataset, et('18:20:00'));
    expect(state.integrity.warnings).toEqual([]);
    expect(state.integrity.appliedCount).toBe(1163);
    expect(state.integrity.ignoredCount).toBe(0);
  });
});
