import { describe, expect, it } from 'vitest';
import { listOffers, offerState } from '../src';
import { ctx, delivered, phys, run, SYSTEM } from './act.helpers';
import { et } from './helpers';

// Brief "Notification and Safety Constraints": "Offers expire if not answered within 10 minutes." OQ-36: inclusive at 10:00.
const { log, offerId } = delivered(ctx, 'PHY-009'); // delivered 18:22:00
const accept = (ms: number, id: string) => run(ctx, log, { type: 'respond', commandId: id, actor: phys('PHY-009'), offerId, physicianId: 'PHY-009', response: 'accept' }, new Date(ms - 4 * 3_600_000).toISOString().slice(11, 23));

describe('offer expiry (OQ-36, OFFER_EXPIRY_BOUNDARY = inclusive)', () => {
  it('9:59.999 after delivery the offer is still open (1 ms left); exactly 10:00 it is expired', () => {
    expect(offerState(log, offerId, et('18:31:59.999'))).toMatchObject({ status: 'delivered', msUntilExpiry: 1 });
    expect(offerState(log, offerId, et('18:32:00'))).toMatchObject({ status: 'expired', msUntilExpiry: null, expiryMaterialized: false });
  });

  it('accept at 9:59.999 succeeds; accept at exactly 10:00 -> EXPIRED', () => {
    expect(accept(et('18:31:59.999'), 'acc-early').ok).toBe(true);
    const late = accept(et('18:32:00'), 'acc-late');
    expect(late).toMatchObject({ ok: false, code: 'EXPIRED' });
    expect(!late.ok && late.message).toMatch(/expired at 18:32:00 ET/);
  });

  it('tick materializes offer_expired once (expiredAtMs = delivery + 10 min); a second tick emits nothing', () => {
    const t1 = run(ctx, log, { type: 'tick', commandId: 'tick-1', actor: SYSTEM }, '18:40:00');
    if (!t1.ok) throw new Error(t1.message);
    expect(t1.emitted.map((e) => [e.type, e.type === 'offer_expired' ? e.payload.expiredAtMs : null])).toEqual([['offer_expired', et('18:32:00')]]);
    const t2 = run(ctx, t1.log, { type: 'tick', commandId: 'tick-2', actor: SYSTEM }, '18:41:00');
    expect(t2.ok && [t2.emitted.length, t2.log.length]).toEqual([0, t1.log.length]);
    expect(offerState(t1.log, offerId, et('18:40:00'))).toMatchObject({ status: 'expired', expiryMaterialized: true });
  });

  it('a tick before expiry emits nothing; derived expiry offers the tick to the system role only until materialized', () => {
    const early = run(ctx, log, { type: 'tick', commandId: 'tick-0', actor: SYSTEM }, '18:31:00');
    expect(early.ok && early.emitted).toEqual([]);
    expect(listOffers(log, et('18:32:00'))[0]?.allowedActions).toEqual({ coordinator: [], clinical_lead: [], physician: [], system: ['tick'] });
    expect(listOffers(log, et('18:25:00'))[0]?.allowedActions).toEqual({ coordinator: ['cancelOffer'], clinical_lead: ['cancelOffer'], physician: ['respond'], system: [] });
  });

  it('cancelling an expired offer is INVALID_STATE; declining after expiry is EXPIRED', () => {
    expect(run(ctx, log, { type: 'cancelOffer', commandId: 'cx', actor: { role: 'coordinator', id: 'c' }, offerId, reason: 'late' }, '18:33:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(run(ctx, log, { type: 'respond', commandId: 'dx', actor: phys('PHY-009'), offerId, physicianId: 'PHY-009', response: 'decline' }, '18:33:00')).toMatchObject({ ok: false, code: 'EXPIRED' });
  });
});
