import { describe, expect, it } from 'vitest';
import { replay, toSnapshotConsultRows, toSnapshotPhysicianRows, type NetworkState } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et, seededShuffle } from './helpers';

const dataset = loadDataset(DATA_DIR);
const view = (s: NetworkState) => ({
  physicians: toSnapshotPhysicianRows(s),
  consults: toSnapshotConsultRows(s),
  derived: Object.values(s.physicians).map((p) => [p.physicianId, p.derivedState]),
  flags: Object.values(s.physicians).map((p) => [p.physicianId, p.flags]),
});

describe('brief "Availability is inferred": events can arrive late, so state must not depend on arrival order', () => {
  it('correct-mode state at 18:20 is identical for 20 seeded shuffles of the input file order', () => {
    const baseline = view(replay(dataset, et('18:20:00')));
    for (let seed = 1; seed <= 20; seed++) {
      const shuffled = { ...dataset, events: seededShuffle(dataset.events, seed) };
      expect(view(replay(shuffled, et('18:20:00'))), `seed ${seed}`).toEqual(baseline);
    }
  });
});
