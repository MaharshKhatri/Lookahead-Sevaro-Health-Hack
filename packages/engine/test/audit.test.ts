import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appendEventText, auditCsv, auditTrail, AUDIT_CSV_COLUMNS, decide, type ActionLog } from '../src';
import { COORD, LEAD, ctx, dataset, must, offerIdOf, phys } from './act.helpers';
import { clock } from './detect.helpers';
import { et } from './helpers';

// Brief "Notification and Safety Constraints": "Log every offer: who was considered, who was excluded and why, who approved, and the outcome."
let log: ActionLog = must(ctx, [], { type: 'proposeOffer', commandId: 'p', actor: COORD, physicianId: 'PHY-009' }, '18:21:00');
const offerId = offerIdOf(log, 'PHY-009');
log = must(ctx, log, { type: 'approveOffer', commandId: 'a', actor: LEAD, offerId, note: 'approved for stroke coverage' }, '18:22:00');
log = must(ctx, log, { type: 'respond', commandId: 'r', actor: phys('PHY-009'), offerId, physicianId: 'PHY-009', response: 'accept' }, '18:24:00');
const golden = JSON.parse(readFileSync(fileURLToPath(new URL('./golden/eligibility_1820.json', import.meta.url)), 'utf8')) as { physicianId: string; failed: string[] }[];

describe('audit trail (from the frozen action log only)', () => {
  const t = auditTrail(log, offerId);

  it('who was considered (all 6), who was excluded and why, matching the eligibility golden', () => {
    expect(t?.considered.map((x) => [x.physicianId, x.eligible, x.rank])).toEqual([
      ['PHY-009', true, 1],
      ['PHY-010', false, null],
      ['PHY-011', false, null],
      ['PHY-012', false, null],
      ['PHY-013', false, null],
      ['PHY-014', false, null],
    ]);
    expect(t?.excluded.map((x) => [x.physicianId, x.failedRules])).toEqual(golden.filter((g) => g.failed.length > 0).map((g) => [g.physicianId, g.failed]));
    expect(t?.excluded.find((x) => x.physicianId === 'PHY-014')?.why).toEqual(['ELIG_HOURS_60: 59 h + minimum 2 h offer = 61 h > 60 (headroom 1 h)']);
  });

  it('who proposed, who approved, when sent, on which channel, with which text, and the outcome', () => {
    expect([t?.proposed.by, clock(t?.proposed.atMs ?? 0)]).toEqual([COORD, '18:21:00']);
    expect([t?.approved?.by, clock(t?.approved?.atMs ?? 0), t?.approved?.note]).toEqual([LEAD, '18:22:00', 'approved for stroke coverage']);
    expect([clock(t?.sentAtMs ?? 0), t?.channel]).toEqual(['18:22:00', 'app_push']);
    expect(t?.messageText).toMatch(/^Split-shift offer from the operations team\.\nHospitals: Suncrest Medical Pavilion, Northfield Medical, Oak Valley Medical\./);
    expect(t?.outcome).toEqual({ status: 'accepted', atMs: et('18:24:00'), by: phys('PHY-009'), detail: 'online from 18:39:00 until 22:36:00 ET' });
    expect(t?.coverageEffect?.filledNeedIds).toHaveLength(3);
    expect(t?.cancellationsCaused).toEqual([]);
  });

  it('reproducible: identical after the dataset gains new events (decide would now see a different world)', () => {
    const appended = appendEventText(
      dataset,
      'EVT-90201,2026-03-17T18:23:00-04:00,2026-03-17T18:23:02-04:00,CON-9201,consult_received,,SYN-005,Stroke consult request received',
      { nowMs: et('18:25:00') },
    );
    expect(appended.accepted).toHaveLength(1);
    expect(decide(appended.dataset, et('18:25:00')).detection.state.consults['CON-9201']).toBeDefined();
    expect(auditTrail(log, offerId)).toEqual(t);
    expect(auditCsv(log)).toBe(auditCsv(log));
  });

  it('CSV: stable columns (header pinned), one line per offer, quotes escaped', () => {
    const csv = auditCsv(log);
    const [header, ...rows] = csv.trim().split('\n');
    expect(header).toBe(
      'offer_id,slot_id,physician_id,physician_name,needs,window_start,window_end,routing_scope,seeded_consults,considered,eligible,excluded,proposed_by,proposed_at,approved_by,approved_at,rejected_by,rejected_at,reject_reason,sent_at,channel,message,outcome,outcome_at,outcome_by,outcome_detail,cancellations_caused',
    );
    expect(header?.split(',')).toEqual([...AUDIT_CSV_COLUMNS]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`${offerId},slot-${offerId},PHY-009,Dr. Grace Okafor,`);
    expect(rows[0]).toContain(',2026-03-17T18:36:00-04:00,2026-03-17T22:36:00-04:00,SYN-005 SYN-008 SYN-010,14,6,PHY-009,');
    expect(rows[0]).toContain(',accepted,2026-03-17T18:24:00-04:00,physician:PHY-009,online from 18:39:00 until 22:36:00 ET,');
  });

  it('an unknown offer has no trail', () => {
    expect(auditTrail(log, 'off-nope')).toBeNull();
  });
});
