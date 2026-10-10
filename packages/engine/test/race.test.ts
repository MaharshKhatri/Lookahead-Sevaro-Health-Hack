import { describe, expect, it } from 'vitest';
import { auditTrail, decide, headSeq, listOffers, type ActContext, type ActionLog } from '../src';
import { COORD, LEAD, must, offerIdOf, phys, run, twoEligible } from './act.helpers';
import { et } from './helpers';

// Brief "Notification and Safety Constraints": "Handle the case where two physicians accept the same offer." OQ-37 parallel dispatch.
const par: ActContext = { dataset: twoEligible, dispatchMode: 'parallel', parallelK: 2 };

let slot: ActionLog = must(par, [], { type: 'proposeSlot', commandId: 'slot-1', actor: COORD }, '18:21:00');
const o9 = offerIdOf(slot, 'PHY-009');
const o14 = offerIdOf(slot, 'PHY-014');
slot = must(par, slot, { type: 'approveOffer', commandId: 'ap9', actor: LEAD, offerId: o9 }, '18:22:00');
slot = must(par, slot, { type: 'approveOffer', commandId: 'ap14', actor: LEAD, offerId: o14 }, '18:22:00');
const accept = (log: ActionLog, id: string, offerId: string, cmd: string, expectedSeq?: number) =>
  run(par, log, { type: 'respond', commandId: cmd, actor: phys(id), offerId, physicianId: id, response: 'accept', ...(expectedSeq === undefined ? {} : { expectedSeq }) }, '18:24:00');

describe('parallel dispatch: one slot to the top-K eligible, first accept wins (OQ-37)', () => {
  it('fixture: with PHY-014 at 40 h, two physicians are eligible (PHY-009 rank 1, PHY-014 rank 2)', () => {
    expect(decide(twoEligible, et('18:21:00')).ledger.filter((e) => e.eligible).map((e) => [e.physicianId, e.rank])).toEqual([
      ['PHY-009', 1],
      ['PHY-014', 2],
    ]);
  });

  it('proposeSlot offers the same slot to both; both are delivered', () => {
    const offers = listOffers(slot, et('18:23:00'));
    expect(offers.map((o) => [o.physicianId, o.status])).toEqual([
      ['PHY-009', 'delivered'],
      ['PHY-014', 'delivered'],
    ]);
    expect(new Set(offers.map((o) => o.slotId)).size).toBe(1);
  });

  it('two accepts in log order: the first is accepted, the other offer is superseded, its accept -> NO_LONGER_AVAILABLE', () => {
    const first = accept(slot, 'PHY-014', o14, 'acc14');
    if (!first.ok) throw new Error(first.message);
    expect(first.emitted.map((e) => [e.type, 'offerId' in e.payload ? e.payload.offerId : null])).toEqual([
      ['offer_accepted', o14],
      ['offer_superseded', o9],
    ]);
    const sup = first.emitted[1];
    expect(sup?.type === 'offer_superseded' && sup.payload.reason).toBe('slot filled by another physician (PHY-014 accepted first)');
    expect(sup?.actor.role).toBe('system');
    const second = accept(first.log, 'PHY-009', o9, 'acc9');
    expect(second).toMatchObject({ ok: false, code: 'NO_LONGER_AVAILABLE' });
    expect(listOffers(first.log, et('18:24:00')).map((o) => [o.physicianId, o.status]).sort()).toEqual([
      ['PHY-009', 'superseded'],
      ['PHY-014', 'accepted'],
    ]);
    expect(auditTrail(first.log, o14)?.cancellationsCaused.map((c) => [c.offerId, c.type])).toEqual([[o9, 'offer_superseded']]);
  });

  it('concurrent accepts against the same base version: exactly one succeeds; the other gets CONFLICT (or NO_LONGER_AVAILABLE on retry)', () => {
    const base = headSeq(slot);
    const a = accept(slot, 'PHY-009', o9, 'c9', base);
    expect(a.ok).toBe(true);
    const store = a.ok ? a.log : slot;
    const b = accept(store, 'PHY-014', o14, 'c14', base);
    expect(b).toMatchObject({ ok: false, code: 'CONFLICT' });
    const retry = accept(store, 'PHY-014', o14, 'c14-retry', headSeq(store));
    expect(retry).toMatchObject({ ok: false, code: 'NO_LONGER_AVAILABLE' });
    expect(store.filter((e) => e.type === 'offer_accepted')).toHaveLength(1);
  });

  it('sequential mode (default) refuses a second offer for an overlapping need while one is open', () => {
    const seq: ActContext = { dataset: twoEligible };
    const l = must(seq, [], { type: 'proposeOffer', commandId: 's9', actor: COORD, physicianId: 'PHY-009' }, '18:21:00');
    const r = run(seq, l, { type: 'proposeOffer', commandId: 's14', actor: COORD, physicianId: 'PHY-014' }, '18:21:30');
    expect(r).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(!r.ok && r.message).toMatch(/sequential dispatch \(OQ-37\)/);
    expect(run(seq, l, { type: 'proposeSlot', commandId: 'sl', actor: COORD }, '18:21:30')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });
});
