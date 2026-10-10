import { describe, expect, it } from 'vitest';
import { replay, type RawEvent } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et } from './helpers';

const dataset = loadDataset(DATA_DIR);
let seq = 0;
const ev = (over: Partial<RawEvent> & Pick<RawEvent, 'eventType' | 'eventTime'>): RawEvent => ({
  rowIndex: 50_000 + seq,
  line: 0,
  eventId: `TEST-${++seq}`,
  eventTimeRaw: '',
  ingestedAt: over.eventTime + 1000,
  ingestedAtRaw: '',
  consultId: null,
  physicianId: null,
  hospitalId: null,
  description: '',
  ...over,
});
const withEvents = (...extra: RawEvent[]) => ({ ...dataset, events: [...dataset.events, ...extra] });

describe('out-of-sequence and unexpected events produce warnings, never throws (brief: events "can disagree")', () => {
  it('video_ended before video_started', () => {
    const end = ev({ eventType: 'video_ended', eventTime: et('18:18:00'), consultId: 'CON-2110', physicianId: 'PHY-008', hospitalId: 'SYN-011' });
    const start = ev({ eventType: 'video_started', eventTime: et('18:18:30'), consultId: 'CON-2110', physicianId: 'PHY-008', hospitalId: 'SYN-011' });
    const s = replay(withEvents(end, start), et('18:20:00'));
    expect(s.integrity.warnings.some((w) => w.startsWith(`${end.eventId}: video_ended without a matching video_started`))).toBe(true);
    expect(s.integrity.warnings.some((w) => w.includes('moves backwards'))).toBe(true);
  });

  it('a call end with no call, a stage event after sign-off, and an event for an unknown consult', () => {
    const callEnd = ev({ eventType: 'incoming_call_ended', eventTime: et('18:18:00'), consultId: 'CON-2110', physicianId: 'PHY-008' });
    const afterSignOff = ev({ eventType: 'imaging_requested', eventTime: et('18:18:10'), consultId: 'CON-1001', physicianId: 'PHY-003' });
    const unknown = ev({ eventType: 'consult_triaged', eventTime: et('18:18:20'), consultId: 'CON-9999', hospitalId: 'SYN-001' });
    const s = replay(withEvents(callEnd, afterSignOff, unknown), et('18:20:00'));
    const w = s.integrity.warnings.join('\n');
    expect(w).toContain(`${callEnd.eventId}: incoming_call_ended without a matching incoming call`);
    expect(w).toContain(`${afterSignOff.eventId}: imaging_requested after consult CON-1001 was signed off`);
    expect(w).toContain(`${unknown.eventId}: consult_triaged for consult CON-9999 before any consult_received`);
    expect(s.consults['CON-1001']?.stage).toBe('Signed Off');
    expect(s.consults['CON-9999']?.stage).toBe('Triaged');
  });

  it('a physician not on the roster is tracked with a warning', () => {
    const s = replay(withEvents(ev({ eventType: 'physician_status_changed', eventTime: et('18:18:00'), physicianId: 'PHY-009', description: 'Self-reported status: Available' })), et('18:20:00'));
    expect(s.physicians['PHY-009']).toMatchObject({ onRoster: false, name: 'Dr. Grace Okafor', shift: null });
    expect(s.integrity.warnings.some((w) => w.includes('PHY-009 is not in physicians_on_shift.csv'))).toBe(true);
  });

  it('events missing a needed id, or with an unrecognised status, are ignored and counted', () => {
    const noPhysician = ev({ eventType: 'camera_active', eventTime: et('18:18:00') });
    const badStatus = ev({ eventType: 'physician_status_changed', eventTime: et('18:18:05'), physicianId: 'PHY-001', description: 'Self-reported status: Napping' });
    const s = replay(withEvents(noPhysician, badStatus), et('18:20:00'));
    expect(s.integrity.ignoredCount).toBe(2);
    expect(s.physicians['PHY-001']?.selfStatus.value).toBe('Available');
  });

  it('OQ-25: re-entering the current stage keeps the original entry time', () => {
    const again = ev({ eventType: 'imaging_requested', eventTime: et('18:10:00'), consultId: 'CON-2102', physicianId: 'PHY-003' });
    const s = replay(withEvents(again), et('18:20:00'));
    expect(s.consults['CON-2102']).toMatchObject({ stage: 'CT/CTA or Imaging Pending', stageEnteredMs: et('17:54:00') });
  });

  it('a known event dated after asOf is deferred until its event_time', () => {
    const future = ev({ eventType: 'consult_received', eventTime: et('18:30:00'), ingestedAt: et('18:19:00'), consultId: 'CON-9998', hospitalId: 'SYN-005', description: 'Stroke consult request received' });
    const s = replay(withEvents(future), et('18:20:00'));
    expect(s.consults['CON-9998']).toBeUndefined();
    expect(s.integrity.warnings).toContain('1 known event(s) dated after asOf deferred until their event_time');
  });
});
