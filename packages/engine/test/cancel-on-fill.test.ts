import { describe, expect, it } from 'vitest';
import { listOffers, type ActContext, type ActionLog } from '../src';
import { COORD, LEAD, must, need1820, offerIdOf, phys, run, twoEligible } from './act.helpers';
import { et } from './helpers';

// Brief "Act": "stop sending offers once the gap is filled"; OQ-40 (NEED_FILLED_RULE).
const par: ActContext = { dataset: twoEligible, dispatchMode: 'parallel' };
const deadlocks = [need1820('DEADLOCK_NOW', 'SYN-005').id, need1820('DEADLOCK_NOW', 'SYN-010').id];

function twoSlots(needIds14?: readonly string[]): { log: ActionLog; o9: string; o14: string } {
  let log = must(par, [], { type: 'proposeOffer', commandId: 'p9', actor: COORD, physicianId: 'PHY-009' }, '18:21:00');
  log = must(par, log, { type: 'proposeOffer', commandId: 'p14', actor: COORD, physicianId: 'PHY-014', ...(needIds14 === undefined ? {} : { needIds: needIds14 }) }, '18:21:00');
  const o9 = offerIdOf(log, 'PHY-009');
  const o14 = offerIdOf(log, 'PHY-014');
  log = must(par, log, { type: 'approveOffer', commandId: 'a9', actor: LEAD, offerId: o9 }, '18:22:00');
  return { log, o9, o14 };
}

describe('cancel on fill (separate slots, parallel dispatch)', () => {
  it('a second open offer whose needs (both deadlocks) are all filled by the acceptance is cancelled with the reason', () => {
    const { log, o9, o14 } = twoSlots(deadlocks);
    const r = run(par, log, { type: 'respond', commandId: 'acc9', actor: phys('PHY-009'), offerId: o9, physicianId: 'PHY-009', response: 'accept' }, '18:24:00');
    if (!r.ok) throw new Error(r.message);
    expect(r.emitted.map((e) => e.type)).toEqual(['offer_accepted', 'offer_cancelled']);
    const c = r.emitted[1];
    expect(c?.type === 'offer_cancelled' && c.payload).toMatchObject({ offerId: o14, cause: 'gap_filled', filledBy: o9 });
    expect(c?.type === 'offer_cancelled' && c.payload.reason).toBe(
      'gap filled: DEADLOCK_NOW SYN-005 18:21-19:00: filled from 18:39 by PHY-009; DEADLOCK_NOW SYN-010 18:21-20:00: filled from 18:39 by PHY-009',
    );
    expect(listOffers(r.log, et('18:24:00')).find((o) => o.offerId === o14)?.status).toBe('cancelled');
    // The cancelled offer was never approved: the physician was never contacted.
    expect(run(par, r.log, { type: 'approveOffer', commandId: 'a14', actor: LEAD, offerId: o14 }, '18:25:00')).toMatchObject({ ok: false, code: 'NO_LONGER_AVAILABLE' });
  });

  it('an open offer that still has an unfilled need (HARD_GAP SYN-005 reopens at 22:36) stays open', () => {
    const { log, o9, o14 } = twoSlots();
    const r = run(par, log, { type: 'respond', commandId: 'acc9b', actor: phys('PHY-009'), offerId: o9, physicianId: 'PHY-009', response: 'accept' }, '18:24:00');
    if (!r.ok) throw new Error(r.message);
    expect(r.emitted.map((e) => e.type)).toEqual(['offer_accepted']);
    expect(listOffers(r.log, et('18:24:00')).find((o) => o.offerId === o14)?.status).toBe('proposed');
  });

  it('a delivered (not just proposed) second offer is cancelled the same way, and its later accept -> NO_LONGER_AVAILABLE', () => {
    const t = twoSlots(deadlocks);
    const log = must(par, t.log, { type: 'approveOffer', commandId: 'a14b', actor: LEAD, offerId: t.o14 }, '18:22:30');
    const r = run(par, log, { type: 'respond', commandId: 'acc9c', actor: phys('PHY-009'), offerId: t.o9, physicianId: 'PHY-009', response: 'accept' }, '18:24:00');
    if (!r.ok) throw new Error(r.message);
    expect(r.emitted.map((e) => e.type)).toEqual(['offer_accepted', 'offer_cancelled']);
    expect(run(par, r.log, { type: 'respond', commandId: 'acc14', actor: phys('PHY-014'), offerId: t.o14, physicianId: 'PHY-014', response: 'accept' }, '18:25:00')).toMatchObject({
      ok: false,
      code: 'NO_LONGER_AVAILABLE',
    });
  });
});
