import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decision1820, ledgerRow } from './decide.helpers';
import { et } from './helpers';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('./golden/eligibility_1820.json', import.meta.url)), 'utf8')) as unknown[];
const r = decision1820();
const entry = (id: string) => r.ledger.find((e) => e.physicianId === id);
const failed = (id: string) => entry(id)?.rules.filter((x) => x.pass === false).map((x) => x.rule);

describe('brief "Coverage and Split-Shift Eligibility" ledger at 18:20 (golden)', () => {
  it('lists every off-shift physician (none filtered silently) and matches test/golden/eligibility_1820.json', () => {
    expect(r.ledger.map((e) => e.physicianId)).toEqual(['PHY-009', 'PHY-010', 'PHY-011', 'PHY-012', 'PHY-013', 'PHY-014']);
    expect(r.ledger.map(ledgerRow)).toEqual(golden);
  });

  it('brief: "exactly one is eligible": PHY-009 is the only eligible physician, rank 1', () => {
    expect(r.ledger.filter((e) => e.eligible).map((e) => [e.physicianId, e.rank])).toEqual([['PHY-009', 1]]);
  });

  it('PHY-009 window: start 18:35 ET (18:20 + 15 min to online), end 22:35 (MAX_OFFER_HOURS), 24 h headroom', () => {
    const w = entry('PHY-009')?.offerWindow;
    expect(w).toMatchObject({ sentMs: et('18:20:00'), startMs: et('18:35:00'), endMs: et('22:35:00'), minutesToOnline: 15, bindingCap: 'max_offer_hours' });
    expect(w?.caps.map((c) => [c.kind, c.atMs])).toEqual([
      ['needs_end', et('23:20:00')], // HARD_GAP SYN-005 persists past the 300-min decision projection (OQ-31)
      ['max_offer_hours', et('22:35:00')],
      ['next_scheduled_shift', Date.parse('2026-03-18T19:00:00-04:00')],
      ['hours_headroom', Date.parse('2026-03-18T18:35:00-04:00')], // 60 - 36 = 24 h after the start
    ]);
  });

  it('rule 6 math (OQ-08), explicit: offered (end - now) = 255 min, minus 15 min to online = 240 min >= 120', () => {
    const w = entry('PHY-009')?.offerWindow;
    expect(w?.offeredMinutes).toBe((et('22:35:00') - et('18:20:00')) / 60_000);
    expect(w?.offeredMinutes).toBe(255);
    expect(w?.effectiveMinutes).toBe(255 - 15);
    expect(entry('PHY-009')?.rules.find((x) => x.rule === 'ELIG_MIN_OFFER_2H')).toMatchObject({ pass: true, detail: 'offered 18:20-22:35 = 255 min, minus 15 min to come online = 240 min >= 120 (OQ-08)' });
  });

  it('PHY-010 fails rule 2 only (credentialed at SYN-002/003/006/007; no gap hospital; SYN-003 is AT_RISK only, OQ-30)', () => {
    expect(failed('PHY-010')).toEqual(['ELIG_CREDENTIALED_AT_GAP']);
    expect(entry('PHY-010')?.rules.find((x) => x.rule === 'ELIG_MIN_OFFER_2H')?.pass).toBeNull();
  });

  it('PHY-011 fails rule 5 only: next shift 19:00 is 40 min after the offered start', () => {
    expect(failed('PHY-011')).toEqual(['ELIG_NO_SCHEDULE_OVERLAP']);
    expect(entry('PHY-011')?.rules.find((x) => x.rule === 'ELIG_NO_SCHEDULE_OVERLAP')?.detail).toMatch(/starts 40 min after offered start 18:20/);
  });

  it('PHY-012 fails rule 1 (opt-in No) and rule 5 (next shift 20:00, 100 min away); rule 6 also fails: its only qualifying need ends at 20:00', () => {
    expect(failed('PHY-012')).toEqual(['ELIG_OPT_IN', 'ELIG_NO_SCHEDULE_OVERLAP', 'ELIG_MIN_OFFER_2H']);
    expect(entry('PHY-012')?.rules.find((x) => x.rule === 'ELIG_MIN_OFFER_2H')?.detail).toBe('offered 18:20-20:00 = 100 min, minus 0 min to come online = 100 min < 120 (OQ-08)');
  });

  it('PHY-013 fails rule 1 only (opt-in No)', () => {
    expect(failed('PHY-013')).toEqual(['ELIG_OPT_IN']);
  });

  it('PHY-014 fails rule 4 only: 59 h + 2 h minimum = 61 h > 60', () => {
    expect(failed('PHY-014')).toEqual(['ELIG_HOURS_60']);
    expect(entry('PHY-014')?.rules.find((x) => x.rule === 'ELIG_HOURS_60')?.detail).toBe('59 h + minimum 2 h offer = 61 h > 60 (headroom 1 h)');
  });

  it('OQ-33 value for PHY-009: weighted need-minutes inside 18:35-22:35 at its scope hospitals = 1095', () => {
    const terms = entry('PHY-009')?.valueTerms.map((t) => [t.kind, t.hospitalId, t.minutes, t.weight]);
    expect(terms).toEqual([
      ['DEADLOCK_NOW', 'SYN-005', 25, 3],
      ['DEADLOCK_NOW', 'SYN-010', 85, 3],
      ['AT_RISK', 'SYN-005', 60, 1],
      ['HARD_GAP', 'SYN-005', 155, 2],
      ['HARD_GAP', 'SYN-008', 120, 2],
      ['AT_RISK', 'SYN-010', 155, 1],
    ]);
    expect(entry('PHY-009')?.value).toBe(25 * 3 + 85 * 3 + 60 + 155 * 2 + 120 * 2 + 155);
  });
});
