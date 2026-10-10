import { describe, expect, it } from 'vitest';
import { decideWithLog, listOffers, offerState, type ActionLog } from '../src';
import { COORD, LEAD, ctx, dataset, must, need1820, offerIdOf, phys, run } from './act.helpers';
import { clock } from './detect.helpers';
import { et } from './helpers';

// Brief "Problem to Solve" layer 3 (Act) + "What Teams Must Demonstrate" #6: propose, approve, send (simulated), accept, update projected coverage.
let log: ActionLog = must(ctx, [], { type: 'proposeOffer', commandId: 'c-propose', actor: COORD, physicianId: 'PHY-009' }, '18:21:00');
const offerId = offerIdOf(log, 'PHY-009');
log = must(ctx, log, { type: 'approveOffer', commandId: 'c-approve', actor: LEAD, offerId }, '18:22:00');
const accept = run(ctx, log, { type: 'respond', commandId: 'c-accept', actor: phys('PHY-009'), offerId, physicianId: 'PHY-009', response: 'accept' }, '18:24:00');
if (!accept.ok) throw new Error(accept.message);
log = accept.log;

describe('happy loop: 18:21 propose -> 18:22 approve -> delivered -> 18:24 accept', () => {
  it('the log holds exactly proposed, approved, sent, delivered, accepted in order with seq 1..5', () => {
    expect(log.map((e) => [e.seq, e.type, e.actor.role, clock(e.atMs)])).toEqual([
      [1, 'offer_proposed', 'coordinator', '18:21:00'],
      [2, 'offer_approved', 'clinical_lead', '18:22:00'],
      [3, 'offer_sent', 'system', '18:22:00'],
      [4, 'offer_delivered', 'system', '18:22:00'],
      [5, 'offer_accepted', 'physician', '18:24:00'],
    ]);
  });

  it('proposal re-derives the ledger at 18:21: window 18:36-22:36 (now + 15 min), scope SYN-005/008/010, seed 14', () => {
    const p = log[0]?.type === 'offer_proposed' ? log[0].payload : null;
    expect(p && [clock(p.window.startMs), clock(p.window.endMs), p.routingScope, p.seededConsultCount, p.channel]).toEqual(['18:36:00', '22:36:00', ['SYN-005', 'SYN-008', 'SYN-010'], 14, 'app_push']);
    expect(p?.needs.map((n) => [n.kind, n.hospitalId])).toEqual([
      ['DEADLOCK_NOW', 'SYN-005'],
      ['DEADLOCK_NOW', 'SYN-010'],
      ['HARD_GAP', 'SYN-005'],
      ['HARD_GAP', 'SYN-008'],
    ]);
  });

  it('OQ-39: the accepted offer counts from max(18:36 offered, 18:24 + 15 min) = 18:39 until 22:36', () => {
    const acc = log[4];
    expect(acc?.type === 'offer_accepted' && [clock(acc.payload.effectiveStartMs), clock(acc.payload.endMs)]).toEqual(['18:39:00', '22:36:00']);
    expect(offerState(log, offerId, et('18:30:00'))?.status).toBe('accepted');
  });

  it('coverage update on accept: deadlocks shortened to 18:39, HARD_GAP SYN-008 downgraded, SYN-005 gap reopens at 22:36', () => {
    const changes = Object.fromEntries((accept.coverage?.changes ?? []).map((c) => [`${c.kind} ${c.hospitalId} ${clock(c.startMs)}`, `${c.outcome}: ${c.detail}`]));
    expect(changes['DEADLOCK_NOW SYN-005 18:24:00']).toBe('shortened: DEADLOCK_NOW remains for 15 of 36 min; now DEADLOCK_NOW 18:24-18:39');
    expect(changes['DEADLOCK_NOW SYN-010 18:24:00']).toBe('shortened: DEADLOCK_NOW remains for 15 of 96 min; now DEADLOCK_NOW 18:24-18:39');
    expect(changes['HARD_GAP SYN-008 20:00:00']).toBe('downgraded: now AT_RISK 20:00-22:00');
    expect(changes['HARD_GAP SYN-005 20:00:00']).toBe('shortened: HARD_GAP remains for 48 of 204 min; now AT_RISK 20:00-22:36, HARD_GAP 22:36-beyond');
    expect(accept.coverage?.routableAtStart.map((r) => [r.hospitalId, clock(r.atMs), r.count])).toEqual([
      ['SYN-005', '18:39:00', 1],
      ['SYN-008', '18:39:00', 1],
      ['SYN-010', '18:39:00', 1],
    ]);
  });

  it('after accept, decide(18:39) shows SYN-010 routable >= 1 and no deadlock; at 18:35 PHY-009 is not online yet', () => {
    const at35 = decideWithLog(ctx, log, et('18:35:00'));
    expect(at35.detection.coverage.routableNow['SYN-010']).toBe(0);
    expect(at35.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => [n.hospitalId, n.endMs === 'beyond_horizon' ? 'beyond' : clock(n.endMs)])).toEqual([
      ['SYN-005', '18:39:00'],
      ['SYN-010', '18:39:00'],
    ]);
    const at39 = decideWithLog(ctx, log, et('18:39:00'));
    expect(at39.detection.coverage.routableNow['SYN-010']).toBeGreaterThanOrEqual(1);
    expect(at39.detection.deadlocks).toEqual([]);
    expect(at39.detection.routes['SYN-010']?.chosen).toBe('PHY-009');
  });

  it('a loop completed at 18:20 sharp reproduces the Session 4 what-if exactly (18:35 start, deadlocks 15 min, SYN-005 45 of 200)', () => {
    let l = must(ctx, [], { type: 'proposeOffer', commandId: 'i-p', actor: COORD, physicianId: 'PHY-009' }, '18:20:00');
    const id = offerIdOf(l, 'PHY-009');
    l = must(ctx, l, { type: 'approveOffer', commandId: 'i-a', actor: LEAD, offerId: id }, '18:20:00');
    const r = run(ctx, l, { type: 'respond', commandId: 'i-r', actor: phys('PHY-009'), offerId: id, physicianId: 'PHY-009', response: 'accept' }, '18:20:00');
    if (!r.ok) throw new Error(r.message);
    const byKey = Object.fromEntries((r.coverage?.changes ?? []).map((c) => [`${c.kind} ${c.hospitalId} ${clock(c.startMs)}`, c.detail]));
    expect(byKey['DEADLOCK_NOW SYN-010 18:20:00']).toBe('DEADLOCK_NOW remains for 15 of 100 min; now DEADLOCK_NOW 18:20-18:35');
    expect(byKey['HARD_GAP SYN-005 20:00:00']).toBe('HARD_GAP remains for 45 of 200 min; now AT_RISK 20:00-22:35, HARD_GAP 22:35-beyond');
    expect(byKey['HARD_GAP SYN-008 20:00:00']).toBe('now AT_RISK 20:00-22:00');
  });

  it('brief "stop sending offers once the gap is filled": another offer for the SYN-010 deadlock -> NEED_ALREADY_FILLED', () => {
    const r = run(ctx, log, { type: 'proposeOffer', commandId: 'c-again', actor: COORD, physicianId: 'PHY-014', needIds: [need1820('DEADLOCK_NOW', 'SYN-010').id] }, '18:25:00');
    expect(r).toMatchObject({ ok: false, code: 'NEED_ALREADY_FILLED' });
    expect(!r.ok && r.message).toMatch(/DEADLOCK_NOW SYN-010 18:25-20:00: filled from 18:39 by PHY-009/);
    // PHY-009 again (no needIds): HARD_GAP SYN-005 is not filled (reopens 22:36), so it is an eligibility question: overlaps the accepted shift.
    const again = run(ctx, log, { type: 'proposeOffer', commandId: 'c-again-9', actor: COORD, physicianId: 'PHY-009' }, '18:25:00');
    expect(again).toMatchObject({ ok: false, code: 'NOT_ELIGIBLE' });
    expect(!again.ok && again.message).toMatch(/falls inside an accepted split shift 18:39-22:36 ET/);
  });

  it('the accepted shift is recorded only in our log: dataset untouched, listOffers shows it accepted with no actions left', () => {
    expect(dataset.events.some((e) => e.eventId.startsWith('act-'))).toBe(false);
    expect(listOffers(log, et('18:25:00'))).toMatchObject([{ offerId, status: 'accepted', msUntilExpiry: null, allowedActions: { coordinator: [], clinical_lead: [], physician: [], system: [] } }]);
  });
});
