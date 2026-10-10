import { describe, expect, it } from 'vitest';
import { dedupe, replay, toSnapshotConsultRows, toSnapshotPhysicianRows, type NetworkState } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et } from './helpers';

const dataset = loadDataset(DATA_DIR);
const view = (s: NetworkState) => ({
  physicians: toSnapshotPhysicianRows(s),
  consults: toSnapshotConsultRows(s),
  physicianState: s.physicians,
  consultState: s.consults,
});

describe('brief "What Teams Must Demonstrate" #1: handle duplicate events (OQ-04)', () => {
  it('reports the one duplicate in the stream exactly once and keeps the earlier copy', () => {
    const state = replay(dataset, et('18:20:00'));
    expect(state.integrity.duplicates).toHaveLength(1);
    expect(state.integrity.duplicates[0]).toMatchObject({
      kept: { eventId: 'EVT-00529', line: 530 },
      dropped: { eventId: 'EVT-00529', line: 531 },
    });
  });

  it('injecting every event a second time (re-delivered 1 s later) yields identical state', () => {
    const redelivered = dataset.events.map((e, i) => ({ ...e, ingestedAt: e.ingestedAt + 1000, rowIndex: dataset.events.length + i, line: 0 }));
    const doubled = { ...dataset, events: [...dataset.events, ...redelivered] };
    const state = replay(doubled, et('18:20:00'));
    expect(view(state)).toEqual(view(replay(dataset, et('18:20:00'))));
    expect(state.integrity.duplicates).toHaveLength(dataset.events.length + 1);
  });

  it('same event_id with different content is a conflict: both kept, warning raised', () => {
    const first = dataset.events[0]!;
    const conflicting = { ...first, description: `${first.description} (edited)`, rowIndex: 99_999 };
    const result = dedupe([first, conflicting]);
    expect(result.events).toHaveLength(2);
    expect(result.duplicates).toEqual([]);
    expect(result.warnings[0]).toMatch(/event_id reused with different content/);
  });
});
