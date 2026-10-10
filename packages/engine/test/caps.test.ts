import { describe, expect, it } from 'vitest';
import { appendActions, type ActionLog, type OfferProposal } from '../src';
import { COORD, LEAD, ctx, must, phys, run } from './act.helpers';

// Brief "Notification and Safety Constraints": "No more than one open offer per physician, and no more than 3 offers per physician per week."
// OQ-09: ISO week from Monday 00:00 ET; OQ-41: sent offers plus offers pending approval count.
const proposed = must(ctx, [], { type: 'proposeOffer', commandId: 'p1', actor: COORD, physicianId: 'PHY-009' }, '18:21:00');
const template = proposed[0]?.type === 'offer_proposed' ? proposed[0].payload : (null as unknown as OfferProposal);

/** Test-only: seed a prior offer to PHY-009 that was sent and declined at an earlier instant. */
function seedPrior(log: ActionLog, iso: string, n: number): ActionLog {
  const atMs = Date.parse(iso);
  const offerId = `off-prior-${n}`;
  const steps = [
    { type: 'offer_proposed', actor: COORD, payload: { ...template, offerId, slotId: `slot-${offerId}` } },
    { type: 'offer_approved', actor: LEAD, payload: { offerId, note: null } },
    { type: 'offer_sent', payload: { offerId, channel: 'app_push', message: template.message } },
    { type: 'offer_delivered', payload: { offerId, channel: 'app_push', simulated: true, expiresAtMs: atMs + 600_000 } },
    { type: 'offer_declined', actor: phys('PHY-009'), payload: { offerId } },
  ] as const;
  return appendActions(log, atMs, { role: 'system', id: 'seed' }, `seed-${n}`, steps).log;
}

describe('offer caps', () => {
  it('OPEN_OFFER_EXISTS: a second offer to PHY-009 while the first is open (proposed, then delivered)', () => {
    expect(run(ctx, proposed, { type: 'proposeOffer', commandId: 'p2', actor: COORD, physicianId: 'PHY-009' }, '18:21:30')).toMatchObject({ ok: false, code: 'OPEN_OFFER_EXISTS' });
    const l = must(ctx, proposed, { type: 'approveOffer', commandId: 'a1', actor: LEAD, offerId: template.offerId }, '18:22:00');
    expect(run(ctx, l, { type: 'proposeOffer', commandId: 'p3', actor: COORD, physicianId: 'PHY-009' }, '18:23:00')).toMatchObject({ ok: false, code: 'OPEN_OFFER_EXISTS' });
    // Once declined it is no longer open.
    const d = must(ctx, l, { type: 'respond', commandId: 'r1', actor: phys('PHY-009'), offerId: template.offerId, physicianId: 'PHY-009', response: 'decline' }, '18:23:00');
    expect(run(ctx, d, { type: 'proposeOffer', commandId: 'p4', actor: COORD, physicianId: 'PHY-009' }, '18:24:00').ok).toBe(true);
  });

  it('WEEKLY_CAP: with 3 offers sent this ISO week the 4th is refused; with 2 the 3rd is allowed', () => {
    const two = seedPrior(seedPrior([], '2026-03-16T00:00:00-04:00', 1), '2026-03-17T09:00:00-04:00', 2);
    expect(run(ctx, two, { type: 'proposeOffer', commandId: 'w3', actor: COORD, physicianId: 'PHY-009' }, '18:21:00').ok).toBe(true);
    const three = seedPrior(two, '2026-03-17T10:00:00-04:00', 3);
    const r = run(ctx, three, { type: 'proposeOffer', commandId: 'w4', actor: COORD, physicianId: 'PHY-009' }, '18:21:00');
    expect(r).toMatchObject({ ok: false, code: 'WEEKLY_CAP' });
    expect(!r.ok && r.message).toBe('PHY-009 has 3 offers this ISO week (max 3; OQ-09, OQ-41)');
  });

  it('OQ-09 week boundary: an offer on Sunday 23:59 ET belongs to last week', () => {
    const l = seedPrior(seedPrior(seedPrior([], '2026-03-15T23:59:00-04:00', 1), '2026-03-16T08:00:00-04:00', 2), '2026-03-17T09:00:00-04:00', 3);
    expect(run(ctx, l, { type: 'proposeOffer', commandId: 'wb', actor: COORD, physicianId: 'PHY-009' }, '18:21:00').ok).toBe(true);
  });

  it('OQ-41: offers rejected by the clinical lead never reached the physician and do not count', () => {
    let l: ActionLog = [];
    for (let i = 1; i <= 3; i++) {
      l = must(ctx, l, { type: 'proposeOffer', commandId: `rp${i}`, actor: COORD, physicianId: 'PHY-009' }, `18:2${i}:00`);
      const id = l.at(-1)?.type === 'offer_proposed' ? (l.at(-1) as Extract<ActionLog[number], { type: 'offer_proposed' }>).payload.offerId : '';
      l = must(ctx, l, { type: 'rejectOffer', commandId: `rr${i}`, actor: LEAD, offerId: id, reason: 'not now' }, `18:2${i}:30`);
    }
    expect(run(ctx, l, { type: 'proposeOffer', commandId: 'rp4', actor: COORD, physicianId: 'PHY-009' }, '18:24:00').ok).toBe(true);
  });
});
