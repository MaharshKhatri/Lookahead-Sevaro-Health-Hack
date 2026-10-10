import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { breachRow, report1820 } from './detect.helpers';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('./golden/breaches_1820.json', import.meta.url)), 'utf8')) as ReturnType<typeof breachRow>[];
const rows = report1820().standards.map(breachRow);
const row = (consultId: string) => rows.find((r) => r.consultId === consultId);
const imminent = (consultId: string) => report1820().attention.some((a) => a.kind === 'IMMINENT_BREACH' && a.consultIds.includes(consultId));

describe('brief "Operational Standards" at 18:20 (OQ-05 >= on exact elapsed, OQ-18 note clock)', () => {
  it('matches the recorded table (13 evaluations, one per open consult with an applicable standard)', () => {
    expect(rows).toEqual(golden);
  });

  // The expected list from the session brief; every entry is confirmed by the actual output.
  it('CON-2105 triaged-not-assigned (All, 5/10 min): critical at 10.92 min', () => expect(row('CON-2105')).toMatchObject({ standard: 'TRIAGED_NOT_ASSIGNED', level: 'critical' }));
  it('CON-2110 assigned-not-contacted (Stroke, 3/8 min): critical at 12.75 min', () => expect(row('CON-2110')).toMatchObject({ standard: 'ASSIGNED_NOT_CONTACTED', level: 'critical' }));
  it('CON-2102 CT/CTA or Imaging Pending (Stroke, 12/20 min): critical at 26 min', () => expect(row('CON-2102')).toMatchObject({ standard: 'IMAGING_PENDING', level: 'critical' }));
  it('CON-2112 Imaging Review (Stroke, 6/12 min): critical at 15.17 min', () => expect(row('CON-2112')).toMatchObject({ standard: 'IMAGING_REVIEW', level: 'critical' }));
  it('CON-2115 and CON-2118 General Neuro notes (45/90 min): warning at 50 and exactly 45 min (OQ-05: >=)', () => {
    expect(row('CON-2115')).toMatchObject({ standard: 'NOTE_COMPLETION', level: 'warning', elapsedMin: 50 });
    expect(row('CON-2118')).toMatchObject({ standard: 'NOTE_COMPLETION', level: 'warning', elapsedMin: 45 });
  });
  it('CON-2114 (warning 18:22:10) and CON-2117 (warning 18:25:30) are imminent', () => {
    expect(row('CON-2114')).toMatchObject({ level: 'ok', warnAt: '18:22:10' });
    expect(row('CON-2117')).toMatchObject({ level: 'ok', warnAt: '18:25:30' });
    expect(imminent('CON-2114')).toBe(true);
    expect(imminent('CON-2117')).toBe(true);
  });
  it('also found: CON-2111 Stroke note warning (phone-only, clock from call end 17:45:50, OQ-18); CON-2103 and CON-2108 imminent', () => {
    expect(row('CON-2111')).toMatchObject({ level: 'warning', clockStart: '17:45:50' });
    expect(imminent('CON-2103')).toBe(true);
    expect(imminent('CON-2108')).toBe(true);
  });
  it('General Neuro imaging review and stroke video stages carry no standard (CON-2106, CON-2101, CON-2107)', () => {
    for (const id of ['CON-2106', 'CON-2101', 'CON-2107', 'CON-2104', 'CON-2109']) expect(row(id), id).toBeUndefined();
  });
  it('every evaluation cites the event that started its clock', () => {
    for (const s of report1820().standards) expect(s.because.length, s.consultId).toBeGreaterThan(0);
  });
});
