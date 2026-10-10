import { describe, expect, it } from 'vitest';
import { replay } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et } from './helpers';

const s = replay(loadDataset(DATA_DIR), et('18:20:00'));
const c = (id: string) => s.consults[id];

describe('brief "Consult lifecycle" and "Important Data Model Concepts"', () => {
  it('physician and consult state are separate: PHY-002 is on video for CON-2101 while CON-2106 and CON-2117 progress independently (Figure 3)', () => {
    expect(s.physicians['PHY-002']?.activeVideo?.consultId).toBe('CON-2101');
    expect(s.physicians['PHY-002']?.openConsultIds).toEqual(['CON-2101', 'CON-2106', 'CON-2117']);
    expect([c('CON-2101')?.stage, c('CON-2106')?.stage, c('CON-2117')?.stage]).toEqual(['Video Consult In Progress', 'Imaging Review', 'Note Pending']);
  });

  it('Provider Contacted is entered by incoming_call_started while Assigned; a later outgoing call does not change stage (OQ-18)', () => {
    expect(c('CON-2104')?.stageHistory.map((h) => h.stage)).toEqual(['Received', 'Triaged', 'Assigned', 'Provider Contacted']);
    expect(c('CON-2102')?.stage).toBe('CT/CTA or Imaging Pending');
    expect(c('CON-2102')?.contactedMs).toBe(et('17:46:30'));
  });

  it('"Phone-only consults skip video": the phone-only call end opens Note Pending and starts the note clock (OQ-18)', () => {
    expect(c('CON-2111')).toMatchObject({ phoneOnly: true, stage: 'Documentation', noteClockStartMs: et('17:45:50') });
    expect(c('CON-2111')?.stageHistory.map((h) => h.stage)).toContain('Note Pending');
  });

  it('note clock for a video consult starts at video end ("from end of video or call")', () => {
    expect(c('CON-2103')?.noteClockStartMs).toBe(et('17:46:00'));
    expect(c('CON-2101')?.noteClockStartMs).toBeNull();
  });

  it('routing rule 5: failed routing attempts are recorded on the consult', () => {
    expect(c('CON-2105')?.routingFailures.map((f) => f.atMs)).toEqual([et('18:09:10'), et('18:14:10'), et('18:19:10')]);
    expect(c('CON-2105')?.assignedPhysicianId).toBeNull();
  });

  it('ringing neither assigns nor changes stage (OQ-17)', () => {
    expect(c('CON-2109')).toMatchObject({ stage: 'Received', assignedPhysicianId: null, ringingTo: { physicianId: 'PHY-007', sinceMs: et('18:19:40') } });
  });

  it('routing rule 4 inputs: consults this shift and last answered call', () => {
    expect(s.physicians['PHY-005']).toMatchObject({ consultsThisShift: 15, callsThisShift: 18, lastAnsweredMs: et('18:14:00') });
  });
});
