import { describe, expect, it } from 'vitest';
import { appendEventText, detect } from '../src';
import { dataset } from './detect.helpers';
import { et } from './helpers';

// Judge-style live injection (test-only ids): another stroke consult at the surging hospital.
const TEXT = [
  'EVT-90101,2026-03-17T18:21:00-04:00,2026-03-17T18:21:02-04:00,CON-9101,consult_received,,SYN-005,Stroke consult request received',
  'EVT-90102,2026-03-17T18:21:30-04:00,2026-03-17T18:21:32-04:00,CON-9101,consult_triaged,,SYN-005,Consult triaged',
].join('\n');

describe('brief "What Teams Must Demonstrate" #8: new events update detection without a restart', () => {
  const before = detect(dataset, et('18:22:00'));
  const appended = appendEventText(dataset, TEXT, { nowMs: et('18:21:40') });
  const after = detect(appended.dataset, et('18:22:00'));

  it('both rows are accepted', () => {
    expect(appended.accepted.map((e) => e.eventId)).toEqual(['EVT-90101', 'EVT-90102']);
    expect(appended.rejected).toEqual([]);
  });

  it('SYN-005 trailing count rises 5 -> 6 and the new consult contributes', () => {
    const d = (r: typeof before) => r.demand.find((x) => x.hospitalId === 'SYN-005');
    expect(d(before)?.count).toBe(5);
    expect(d(after)).toMatchObject({ count: 6, spike: true });
    expect(d(after)?.contributingConsultIds).toContain('CON-9101');
  });

  it('the new consult is evaluated against "Triaged, not yet assigned" (warning at 18:26:30)', () => {
    expect(after.standards.find((s) => s.consultId === 'CON-9101')).toMatchObject({ standard: 'TRIAGED_NOT_ASSIGNED', level: 'ok', warnAtMs: et('18:26:30') });
  });

  it('attention is re-ranked: CON-9101 is a new routing deadlock at #2 and an imminent breach', () => {
    const kinds = after.attention.filter((a) => a.consultIds.includes('CON-9101')).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['ROUTING_DEADLOCK', 'IMMINENT_BREACH']));
    expect(after.attention[1]?.consultIds).toEqual(['CON-9101']);
    expect(after.attention.map((a) => a.id)).not.toEqual(before.attention.map((a) => a.id));
  });
});
