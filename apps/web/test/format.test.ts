import { describe, expect, it } from 'vitest';
import { etHm, localHm, zoneAbbr } from '@/lib/format';

/** Hospital local time (UI pass; CLAUDE.md rule 4: local-time logic uses the hospital's IANA zone from hospitals.csv). */
describe('local time helpers', () => {
  const t = Date.parse('2026-03-17T18:20:00-04:00');
  it('formats in the hospital zone, not the machine zone', () => {
    expect(etHm(t)).toBe('18:20');
    expect(localHm(t, 'America/Chicago')).toBe('17:20');
    expect(localHm(t, 'America/Denver')).toBe('16:20');
    expect(localHm(t, 'America/Los_Angeles')).toBe('15:20');
  });
  it('labels the zone briefly and falls back on a bad zone', () => {
    expect(zoneAbbr(t, 'America/Chicago')).toBe('CT');
    expect(zoneAbbr(t, 'America/Los_Angeles')).toBe('PT');
    expect(localHm(t, 'Not/AZone')).toBe('18:20');
  });
});
