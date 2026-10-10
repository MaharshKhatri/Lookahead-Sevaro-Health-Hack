import { describe, expect, it } from 'vitest';
import { report1820 } from './detect.helpers';

describe('brief "Coverage and Split-Shift Eligibility": demand spike = trailing 60-min consults above p90 for that hour (OQ-03, OQ-19)', () => {
  it('at 18:20 SYN-005 is the only spike: 5 consults in (17:20, 18:20] vs p90 1 for the 18:00 ET hour', () => {
    const demand = report1820().demand;
    expect(demand.filter((d) => d.spike).map((d) => d.hospitalId)).toEqual(['SYN-005']);
    expect(demand.find((d) => d.hospitalId === 'SYN-005')).toMatchObject({
      count: 5,
      p90: 1,
      mean: 0.4,
      baselineHourEt: '18:00',
      contributingConsultIds: ['CON-2111', 'CON-2112', 'CON-2113', 'CON-2107', 'CON-2114'],
    });
  });
  it('strictly greater: SYN-010 with 1 consult vs p90 1 is not a spike', () => {
    expect(report1820().demand.find((d) => d.hospitalId === 'SYN-010')).toMatchObject({ count: 1, p90: 1, spike: false });
  });
});
