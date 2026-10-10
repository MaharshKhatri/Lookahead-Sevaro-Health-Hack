import { describe, expect, it } from 'vitest';
import { report1820 } from './detect.helpers';
import { et } from './helpers';

const notes = Object.fromEntries(report1820().openNotes.map((n) => [n.physicianId, n]));

describe('brief "Operational Standards": "Open notes within 60 min of the physician\'s shift end" (Any / 2 or more), OQ-22', () => {
  it('PHY-003 (ends 19:00): CON-2111 Documentation + CON-2115 Note Pending -> critical', () => {
    expect(notes['PHY-003']).toMatchObject({ inWindow: true, count: 2, level: 'critical', noteConsultIds: ['CON-2111', 'CON-2115'] });
  });
  it('PHY-006 (ends 19:00): CON-2118 Note Pending -> warning', () => {
    expect(notes['PHY-006']).toMatchObject({ inWindow: true, count: 1, level: 'warning', noteConsultIds: ['CON-2118'] });
  });
  it('PHY-001/002/005/008 (end 20:00) enter the window at 19:00', () => {
    for (const id of ['PHY-001', 'PHY-002', 'PHY-005', 'PHY-008']) {
      expect(notes[id], id).toMatchObject({ inWindow: false, level: 'ok', windowEntersAtMs: et('19:00:00') });
    }
    expect(notes['PHY-002']?.levelAtWindow).toBe('warning');
  });
});
