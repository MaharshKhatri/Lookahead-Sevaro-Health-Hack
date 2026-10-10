import { describe, expect, it } from 'vitest';
import { lateEventImpact, replay } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et } from './helpers';

const dataset = loadDataset(DATA_DIR);
const codes = (s: ReturnType<typeof replay>, id: string) => s.physicians[id]?.flags.map((f) => f.value.code) ?? [];

describe('brief Operational Situations: "A video-start event arrives several minutes after it happened"', () => {
  it('at 18:15:00 the late video_started is not yet known: CON-2107 not in video, PHY-006 flagged as external video', () => {
    const s = replay(dataset, et('18:15:00'));
    expect(s.consults['CON-2107']?.stage).toBe('Provider Contacted');
    expect(s.physicians['PHY-006']?.activeVideo).toBeNull();
    expect(s.physicians['PHY-006']?.derivedState.value).toBe('Camera Active - No Synapse Session');
    expect(codes(s, 'PHY-006')).toContain('EXTERNAL_VIDEO_SUSPECTED');
  });

  it('one millisecond before ingestion (18:18:04.999) the flag still stands', () => {
    expect(codes(replay(dataset, et('18:18:05') - 1), 'PHY-006')).toContain('EXTERNAL_VIDEO_SUSPECTED');
  });

  it('at 18:18:05 it is known: CON-2107 entered video at its event_time 18:11:20 and the flag is gone', () => {
    const s = replay(dataset, et('18:18:05'));
    expect(s.consults['CON-2107']?.stage).toBe('Video Consult In Progress');
    expect(s.consults['CON-2107']?.stageEnteredMs).toBe(et('18:11:20'));
    expect(s.physicians['PHY-006']?.activeVideo?.consultId).toBe('CON-2107');
    expect(codes(s, 'PHY-006')).not.toContain('EXTERNAL_VIDEO_SUSPECTED');
  });

  it('lateEventImpact at 18:20 reports exactly the facts EVT-01161 corrected', () => {
    expect(lateEventImpact(dataset, et('18:20:00'))).toEqual([
      { eventId: 'EVT-01161', entity: { kind: 'consult', id: 'CON-2107' }, field: 'stage', before: 'Provider Contacted', after: 'Video Consult In Progress', windowStartMs: et('18:11:20'), windowEndMs: et('18:18:05'), windowMs: 405_000 },
      { eventId: 'EVT-01161', entity: { kind: 'consult', id: 'CON-2107' }, field: 'stageEnteredMs', before: et('18:06:10'), after: et('18:11:20'), windowStartMs: et('18:11:20'), windowEndMs: et('18:18:05'), windowMs: 405_000 },
      { eventId: 'EVT-01161', entity: { kind: 'physician', id: 'PHY-006' }, field: 'derivedState', before: 'Camera Active - No Synapse Session', after: 'Video Consult In Progress', windowStartMs: et('18:11:20'), windowEndMs: et('18:18:05'), windowMs: 405_000 },
      { eventId: 'EVT-01161', entity: { kind: 'physician', id: 'PHY-006' }, field: 'activeVideo', before: null, after: 'CON-2107', windowStartMs: et('18:11:20'), windowEndMs: et('18:18:05'), windowMs: 405_000 },
      { eventId: 'EVT-01161', entity: { kind: 'physician', id: 'PHY-006' }, field: 'flag.EXTERNAL_VIDEO_SUSPECTED', before: true, after: false, windowStartMs: et('18:11:22'), windowEndMs: et('18:18:05'), windowMs: 403_000 },
    ]);
  });

  it('lateEventImpact before the late event arrives reports nothing', () => {
    expect(lateEventImpact(dataset, et('18:18:04'))).toEqual([]);
  });
});
