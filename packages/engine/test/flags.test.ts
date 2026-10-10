import { describe, expect, it } from 'vitest';
import { replay } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, et } from './helpers';

const dataset = loadDataset(DATA_DIR);
const state = replay(dataset, et('18:20:00'));
const flagsOf = (id: string) => state.physicians[id]?.flags ?? [];

describe('physician flags at 18:20 (brief "Availability is inferred, not reported" and "Operational Situations")', () => {
  it('PHY-001: camera active with no Synapse session -> EXTERNAL_VIDEO_SUSPECTED', () => {
    expect(flagsOf('PHY-001').map((f) => f.value)).toEqual([{ code: 'EXTERNAL_VIDEO_SUSPECTED', sinceMs: et('18:04:10') }]);
    expect(flagsOf('PHY-001')[0]?.because.map((b) => b.eventId)).toContain('EVT-01132');
  });

  it('PHY-007: looks available but agent offline -> AGENT_OFFLINE_UNVERIFIED; call ringing -> RINGING_UNANSWERED (CON-2109)', () => {
    expect(state.physicians['PHY-007']?.derivedState.value).toBe('Available');
    expect(flagsOf('PHY-007').map((f) => f.value)).toEqual([
      { code: 'AGENT_OFFLINE_UNVERIFIED', sinceMs: et('17:38:00') },
      { code: 'RINGING_UNANSWERED', sinceMs: et('18:19:40'), consultId: 'CON-2109', seconds: 20 },
    ]);
  });

  it('PHY-008: temporarily unavailable with a stroke consult still assigned -> TEMP_UNAVAILABLE_WITH_ASSIGNED (CON-2110)', () => {
    expect(flagsOf('PHY-008').map((f) => f.value)).toEqual([
      { code: 'TEMP_UNAVAILABLE_WITH_ASSIGNED', sinceMs: et('18:12:40'), consultIds: ['CON-2110'] },
    ]);
  });

  it('no other physician carries a flag', () => {
    for (const id of ['PHY-002', 'PHY-003', 'PHY-004', 'PHY-005', 'PHY-006']) expect(flagsOf(id), id).toEqual([]);
  });

  it('every flag and every non-Available derived state has non-empty `because` and a rule code', () => {
    for (const p of Object.values(state.physicians)) {
      for (const f of p.flags) {
        expect(f.because.length, `${p.physicianId} ${f.value.code}`).toBeGreaterThan(0);
        expect(f.rule).toMatch(/^FLAG_/);
      }
      expect(p.derivedState.because.length, p.physicianId).toBeGreaterThan(0);
    }
  });

  it('IN_MEETING_INTERRUPTIBLE while self-reported In Meeting (brief: "internal meetings are interruptible")', () => {
    const midday = replay(dataset, et('13:15:00'));
    const f = midday.physicians['PHY-004']?.flags.find((x) => x.value.code === 'IN_MEETING_INTERRUPTIBLE');
    expect(f?.because.map((b) => b.eventId)).toContain('EVT-00661');
    expect(replay(dataset, et('13:31:00')).physicians['PHY-004']?.flags.map((x) => x.value.code)).not.toContain('IN_MEETING_INTERRUPTIBLE');
  });
});
