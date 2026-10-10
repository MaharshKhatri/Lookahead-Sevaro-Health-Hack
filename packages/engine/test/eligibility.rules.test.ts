import { describe, expect, it } from 'vitest';
import { buildLedger, type LedgerEntry, type Need, type OffShiftPhysician, type OfferLogEntry, type RuleCode } from '../src';
import { clock, dataset, decision1820 } from './decide.helpers';
import { et } from './helpers';

const r = decision1820();
const H = 3_600_000;
const M = 60_000;
const base = dataset.offShiftRoster.find((p) => p.physicianId === 'PHY-009') as OffShiftPhysician;
const baseCreds = [...(r.detection.staffing.credentials.get('PHY-009') ?? [])];
const at = (iso: string) => Date.parse(iso);

interface Synthetic {
  readonly p: Partial<OffShiftPhysician>;
  readonly credentials?: readonly string[];
}

/** Pure ledger over the 18:20 needs for synthetic physicians (test-only rows derived from PHY-009). */
function ledger(people: readonly Synthetic[], opts: { offerLog?: readonly OfferLogEntry[]; needs?: readonly Need[] } = {}): LedgerEntry[] {
  const roster = people.map((s) => ({ ...base, ...s.p }));
  const credentials = new Map(r.detection.staffing.credentials);
  for (const [i, s] of people.entries()) credentials.set(roster[i]?.physicianId ?? '', new Set(s.credentials ?? baseCreds));
  const detection = { ...r.detection, staffing: { ...r.detection.staffing, credentials } };
  return buildLedger({ detection, roster, needs: opts.needs ?? r.needs, decisionHorizonEndMs: r.decisionCoverage.horizonEndMs, offerLog: opts.offerLog ?? [] });
}
const one = (p: Partial<OffShiftPhysician>, credentials?: readonly string[], offerLog?: readonly OfferLogEntry[]) =>
  ledger([{ p, ...(credentials === undefined ? {} : { credentials }) }], offerLog === undefined ? {} : { offerLog })[0] as LedgerEntry;
const rule = (e: LedgerEntry, code: RuleCode) => e.rules.find((x) => x.rule === code);

describe('brief "Coverage and Split-Shift Eligibility" rule boundaries', () => {
  it('rule 3: exactly 10 h of rest at the offered start passes; one minute less fails', () => {
    // Offered start = 18:20 + 15 min = 18:35.
    expect(rule(one({ lastShiftEnd: et('08:35:00') }), 'ELIG_REST_10H')).toMatchObject({ pass: true, detail: 'last shift ended 03-17 08:35 ET; at offered start 18:35 ET: 10 h >= 10 h' });
    expect(rule(one({ lastShiftEnd: et('08:36:00') }), 'ELIG_REST_10H')?.pass).toBe(false);
  });

  it('rule 4: 58 h + a 2-h offer = exactly 60 h passes (window capped by the headroom); 58.5 h fails', () => {
    const ok = one({ hoursWorkedLast7d: 58 });
    expect(rule(ok, 'ELIG_HOURS_60')).toMatchObject({ pass: true, detail: '58 h + offered 2 h = 60 h <= 60 (headroom 2 h before, 0 h after; OQ-20)' });
    expect(ok.offerWindow).toMatchObject({ endMs: et('20:35:00'), effectiveMinutes: 120, bindingCap: 'hours_headroom' });
    expect(ok.eligible).toBe(true);
    const bad = one({ hoursWorkedLast7d: 58.5 });
    expect(rule(bad, 'ELIG_HOURS_60')).toMatchObject({ pass: false, detail: '58.5 h + minimum 2 h offer = 60.5 h > 60 (headroom 1.5 h)' });
    // Rule 6 is sized independently (needs + MAX_OFFER_HOURS), so the failure is attributed to rule 4 only.
    expect(rule(bad, 'ELIG_MIN_OFFER_2H')?.pass).toBe(true);
  });

  it('rule 5 (OQ-21): an offer ending exactly at the next shift start passes; a next shift one minute earlier fails', () => {
    const ok = one({ nextShiftStart: et('20:35:00') });
    expect(rule(ok, 'ELIG_NO_SCHEDULE_OVERLAP')?.pass).toBe(true);
    expect(ok.offerWindow).toMatchObject({ endMs: et('20:35:00'), effectiveMinutes: 120, bindingCap: 'next_scheduled_shift' });
    expect(ok.eligible).toBe(true);
    const bad = one({ nextShiftStart: et('20:34:00') });
    expect(rule(bad, 'ELIG_NO_SCHEDULE_OVERLAP')).toMatchObject({ pass: false });
    expect(rule(bad, 'ELIG_NO_SCHEDULE_OVERLAP')?.detail).toMatch(/starts 119 min after offered start 18:35; any 2-h offer would overlap it/);
  });

  it('rule 6 (OQ-08): time to come online can make a 2-h offer fail (SYN-008 HARD_GAP ends 22:00)', () => {
    const ok = one({ estMinutesToOnline: 100 }, ['SYN-008']);
    expect(rule(ok, 'ELIG_MIN_OFFER_2H')).toMatchObject({ pass: true, detail: 'offered 18:20-22:00 = 220 min, minus 100 min to come online = 120 min >= 120 (OQ-08)' });
    const bad = one({ estMinutesToOnline: 101 }, ['SYN-008']);
    expect(rule(bad, 'ELIG_MIN_OFFER_2H')).toMatchObject({ pass: false, detail: 'offered 18:20-22:00 = 220 min, minus 101 min to come online = 119 min < 120 (OQ-08)' });
    expect(bad.offerWindow).toMatchObject({ startMs: et('20:01:00'), endMs: et('22:00:00'), effectiveMinutes: 119, bindingCap: 'needs_end' });
    expect(bad.eligible).toBe(false);
  });

  it('rule 6 is not applicable (null) without a gap-hospital need; rule 2 then fails and no window or value is given', () => {
    const e = one({}, ['SYN-002']);
    expect(rule(e, 'ELIG_MIN_OFFER_2H')?.pass).toBeNull();
    expect(rule(e, 'ELIG_CREDENTIALED_AT_GAP')?.pass).toBe(false);
    expect([e.offerWindow, e.value, e.eligible]).toEqual([null, null, false]);
  });

  it('rule 1: opt-in No fails regardless of everything else', () => {
    expect(rule(one({ splitShiftOptIn: false }), 'ELIG_OPT_IN')).toMatchObject({ pass: false, detail: 'split_shift_opt_in = No' });
  });
});

describe('brief "Notification and Safety Constraints": offer limits (OQ-09)', () => {
  const log = (sentIso: string, status: OfferLogEntry['status'] = 'declined'): OfferLogEntry => ({ physicianId: 'PHY-009', sentMs: at(sentIso), status });

  it('"one open offer per physician at a time": an open offer blocks a second', () => {
    const e = one({}, undefined, [log('2026-03-17T18:10:00-04:00', 'open')]);
    expect(rule(e, 'SAFETY_ONE_OPEN_OFFER')).toMatchObject({ pass: false, detail: '1 open offer(s) in the offer log (max 1)' });
    expect(e.eligible).toBe(false);
  });

  it('"no more than three offers per physician per week": 3 this ISO week (Monday 00:00 ET) fails, 2 passes, last Sunday does not count', () => {
    const two = [log('2026-03-16T00:00:00-04:00'), log('2026-03-17T09:00:00-04:00')];
    expect(rule(one({}, undefined, two), 'SAFETY_THREE_OFFERS_PER_WEEK')?.pass).toBe(true);
    expect(rule(one({}, undefined, [...two, log('2026-03-15T23:59:00-04:00')]), 'SAFETY_THREE_OFFERS_PER_WEEK')?.pass).toBe(true);
    const three = one({}, undefined, [...two, log('2026-03-17T10:00:00-04:00')]);
    expect(rule(three, 'SAFETY_THREE_OFFERS_PER_WEEK')).toMatchObject({ pass: false, detail: '3 offer(s) since Mon 03-16 00:00 ET (max 3; source offer_log_iso_week_et)' });
  });
});

describe('OQ-34 ranking: value desc, then time to online, then fewer declines', () => {
  it('higher value ranks first; at equal value fewer declines wins', () => {
    const l = ledger([
      { p: { offersDeclinedLast30d: 1 } },
      { p: { physicianId: 'TEST-2', offersDeclinedLast30d: 0 } },
      { p: { physicianId: 'TEST-3' }, credentials: ['SYN-008'] },
    ]);
    expect(l.map((e) => [e.physicianId, e.value, e.rank])).toEqual([
      ['PHY-009', 1095, 2],
      ['TEST-2', 1095, 1],
      ['TEST-3', 120 * 2, 3], // HARD_GAP SYN-008 20:00-22:00 only
    ]);
  });

  it('at equal value the shorter time to online wins', () => {
    const g8 = r.needs.find((n) => n.kind === 'HARD_GAP' && n.hospitalId === 'SYN-008') as Need;
    const needs = [{ ...g8, startMs: et('19:30:00'), endMs: et('21:00:00') }];
    const l = ledger([{ p: { estMinutesToOnline: 30 }, credentials: ['SYN-008'] }, { p: { physicianId: 'TEST-4', estMinutesToOnline: 15 }, credentials: ['SYN-008'] }], { needs });
    expect(l.map((e) => [e.physicianId, e.value, e.rank, e.offerWindow && clock(e.offerWindow.startMs)])).toEqual([
      ['PHY-009', 180, 2, '18:50:00'],
      ['TEST-4', 180, 1, '18:35:00'],
    ]);
  });

  it('windows never start before now + time to online, and H/M arithmetic is exact', () => {
    for (const e of r.ledger) if (e.offerWindow) expect(e.offerWindow.startMs - e.offerWindow.sentMs).toBe(e.offerWindow.minutesToOnline * M);
    expect(H).toBe(60 * M);
  });
});

describe('brief "Act" + eligibility rules 4-5: an accepted split shift is a scheduled shift with hours', () => {
  const ledgerWith = (startHms: string, endHms: string) =>
    buildLedger({
      detection: r.detection,
      roster: [base],
      needs: r.needs,
      decisionHorizonEndMs: r.decisionCoverage.horizonEndMs,
      offerLog: [],
      acceptedOffers: [{ physicianId: 'PHY-009', name: base.name, startMs: et(startHms), endMs: et(endHms), scopeHospitalIds: ['SYN-005'], seededConsultCount: 14 }],
    })[0] as LedgerEntry;

  it('a later accepted shift (21:00-23:00) caps the window (rule 5 room 145 min) and adds 2 h to the 60-h count (rule 4)', () => {
    const e = ledgerWith('21:00:00', '23:00:00');
    expect(rule(e, 'ELIG_NO_SCHEDULE_OVERLAP')).toMatchObject({ pass: true });
    expect(rule(e, 'ELIG_NO_SCHEDULE_OVERLAP')?.detail).toMatch(/^accepted split shift 03-17 21:00 ET starts 2\.4 h after offered start 18:35/);
    expect(e.offerWindow).toMatchObject({ endMs: et('21:00:00'), bindingCap: 'next_scheduled_shift' });
    expect(rule(e, 'ELIG_HOURS_60')?.detail).toMatch(/^38 h \(36 h \+ 2 h accepted split shift\) \+ offered 2\.4 h = 40\.4 h <= 60/);
  });

  it('an accepted shift containing the offered start fails rule 5', () => {
    expect(rule(ledgerWith('18:30:00', '20:30:00'), 'ELIG_NO_SCHEDULE_OVERLAP')).toMatchObject({ pass: false, detail: 'offered start 18:35 falls inside an accepted split shift 18:30-20:30 ET' });
  });
});
