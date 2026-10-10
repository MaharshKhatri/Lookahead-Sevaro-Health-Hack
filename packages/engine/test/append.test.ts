import { describe, expect, it } from 'vitest';
import { appendEventText, parseEventRows, replay } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et } from './helpers';

const dataset = loadDataset(DATA_DIR);
const HEADER = 'event_id,event_time,ingested_at,consult_id,event_type,physician_id,hospital_id,description';
// A judge-style injection: another stroke consult at the surging hospital (test-only IDs).
const NEW_STROKE = 'EVT-90001,2026-03-17T18:21:00-04:00,2026-03-17T18:21:02-04:00,CON-9001,consult_received,,SYN-005,Stroke consult request received';

describe('brief "What Teams Must Demonstrate" #8: judges add new events in the same format; update without a restart', () => {
  it('a new stroke consult at the surging hospital appears in state once known (18:21:02) and not before', () => {
    const r = appendEventText(dataset, `${HEADER}\n${NEW_STROKE}\n`, { nowMs: et('18:21:05') });
    expect(r.header).toBe('present');
    expect(r.accepted.map((e) => e.eventId)).toEqual(['EVT-90001']);
    expect(r.rejected).toEqual([]);
    const s = replay(r.dataset, et('18:21:05'));
    expect(s.consults['CON-9001']).toMatchObject({ hospitalId: 'SYN-005', consultType: 'Stroke', stage: 'Received', receivedMs: et('18:21:00'), open: true });
    expect(replay(r.dataset, et('18:21:01')).consults['CON-9001']).toBeUndefined();
  });

  it('never mutates the input dataset', () => {
    const before = dataset.events.length;
    appendEventText(dataset, NEW_STROKE, { nowMs: et('18:21:05') });
    expect(dataset.events.length).toBe(before);
  });

  it('appending the same row again is a duplicate (OQ-04), not a second consult', () => {
    const once = appendEventText(dataset, NEW_STROKE, { nowMs: et('18:21:05') });
    const twice = appendEventText(once.dataset, NEW_STROKE, { nowMs: et('18:21:10') });
    expect(twice.accepted).toEqual([]);
    expect(twice.duplicates).toEqual([{ line: 1, eventId: 'EVT-90001', reason: 'same event_id and content as an existing event (OQ-04)' }]);
    const sameBatch = appendEventText(dataset, `${NEW_STROKE}\n${NEW_STROKE}\n`, { nowMs: et('18:21:05') });
    expect(sameBatch.accepted).toHaveLength(1);
    expect(sameBatch.duplicates.map((d) => d.line)).toEqual([2]);
  });

  it('a malformed row is rejected with its line number; the good rows are still accepted', () => {
    const text = [
      HEADER,
      NEW_STROKE,
      'EVT-90002,2026-03-17 18:22:00,2026-03-17T18:22:01-04:00,CON-9001,consult_triaged,,SYN-005,Consult triaged',
      'EVT-90003,2026-03-17T18:22:30-04:00,2026-03-17T18:22:31-04:00,CON-9001,consult_escalated,,SYN-005,Not a brief event type',
      'EVT-90004,2026-03-17T18:23:00-04:00,2026-03-17T18:23:01-04:00,CON-9001',
    ].join('\n');
    const r = appendEventText(dataset, text, { nowMs: et('18:24:00') });
    expect(r.accepted.map((e) => e.eventId)).toEqual(['EVT-90001']);
    expect(r.rejected.map((x) => x.line)).toEqual([3, 4, 5]);
    expect(r.rejected[0]?.reason).toMatch(/column "event_time"/);
    expect(r.rejected[1]?.reason).toMatch(/column "event_type" value "consult_escalated"/);
    expect(r.rejected[2]?.reason).toMatch(/expected 8 cells, got 4/);
  });

  it('a header-less row with the file\'s 8 columns is accepted', () => {
    const r = appendEventText(dataset, NEW_STROKE, { nowMs: et('18:21:05') });
    expect(r.header).toBe('absent');
    expect(r.accepted).toHaveLength(1);
  });

  it('tolerates a UTF-8 BOM and CRLF line endings in pasted text', () => {
    const r = appendEventText(dataset, `\uFEFF${HEADER}\r\n${NEW_STROKE}\r\n`, { nowMs: et('18:21:05') });
    expect(r.header).toBe('present');
    expect(r.accepted).toHaveLength(1);
  });

  it('a blank ingested_at is stamped with nowMs and reported', () => {
    const row = 'EVT-90005,2026-03-17T18:21:30-04:00,,CON-9002,consult_received,,SYN-005,Stroke consult request received';
    const r = appendEventText(dataset, row, { nowMs: et('18:21:40') });
    expect(r.accepted[0]?.ingestedAt).toBe(et('18:21:40'));
    expect(r.accepted[0]?.ingestedAtRaw).toBe('2026-03-17T18:21:40-04:00');
    expect(r.ingestedAtDefaulted).toEqual([{ line: 1, eventId: 'EVT-90005' }]);
  });

  it('unknown IDs are accepted with a warning; a missing column the event type needs is rejected', () => {
    const r = appendEventText(
      dataset,
      [
        'EVT-90006,2026-03-17T18:22:00-04:00,2026-03-17T18:22:01-04:00,CON-9003,consult_received,,SYN-999,Stroke consult request received',
        'EVT-90007,2026-03-17T18:22:10-04:00,2026-03-17T18:22:11-04:00,CON-9003,physician_assigned,,SYN-999,Consult assigned',
      ].join('\n'),
      { nowMs: et('18:23:00') },
    );
    expect(r.accepted.map((e) => e.eventId)).toEqual(['EVT-90006']);
    expect(r.warnings).toEqual(['EVT-90006: unknown hospital_id SYN-999']);
    expect(r.rejected).toEqual([{ line: 2, reason: 'physician_assigned requires physician_id' }]);
  });

  it('accepts a header with alternate names through a column mapping', () => {
    const parsed = parseEventRows(`id,event_time,ingested_at,consult_id,type,physician_id,hospital_id,description\n${NEW_STROKE}`, {
      mapping: { id: 'event_id', type: 'event_type' },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.events[0]?.eventType).toBe('consult_received');
  });
});
