import { describe, expect, it } from 'vitest';
import { etDateOf, etWallClockToEpoch } from '../src';

describe('ET wall-clock conversion (brief "Synthetic Dataset": "07:00-18:20 Eastern")', () => {
  it('reads 18:20 on the scenario date as -04:00 (EDT)', () => {
    expect(etWallClockToEpoch('2026-03-17', 18 * 3600 + 20 * 60)).toBe(Date.parse('2026-03-17T18:20:00-04:00'));
  });

  it('uses the zone rules, not a fixed offset, across the DST change (2026-03-08)', () => {
    expect(etWallClockToEpoch('2026-03-07', 12 * 3600)).toBe(Date.parse('2026-03-07T12:00:00-05:00'));
    expect(etWallClockToEpoch('2026-03-08', 12 * 3600)).toBe(Date.parse('2026-03-08T12:00:00-04:00'));
  });

  it('rolls seconds past midnight onto the next calendar day', () => {
    expect(etWallClockToEpoch('2026-03-17', 86_400 + 7 * 3600)).toBe(Date.parse('2026-03-18T07:00:00-04:00'));
  });

  it('gives the ET calendar date of an instant, independent of the machine zone', () => {
    expect(etDateOf(Date.parse('2026-03-18T02:30:00Z'))).toBe('2026-03-17');
  });

  it('rejects malformed dates', () => {
    expect(() => etWallClockToEpoch('03/17/2026', 0)).toThrow(/invalid ET date/);
  });
});
