import { describe, expect, it } from 'vitest';
import type { ActionLog } from '../src';
import { COORD, LEAD, ctx, must, offerIdOf, run } from './act.helpers';

// Brief "Notification and Safety Constraints": "No patient information in any notification. Hospital names, hours and start time only."
// assertNoPHI-equivalent check runs at send time (approval); a failing message is never sent.
const proposed = must(ctx, [], { type: 'proposeOffer', commandId: 'p', actor: COORD, physicianId: 'PHY-009' }, '18:21:00');
const offerId = offerIdOf(proposed, 'PHY-009');

/** Test-only tampering: the frozen message in the log is altered after proposal. */
const tamper = (f: (m: string) => string): ActionLog => proposed.map((e) => (e.type === 'offer_proposed' ? { ...e, payload: { ...e.payload, message: f(e.payload.message) } } : e));

describe('PHI enforcement at send time', () => {
  it('the untampered message is sent', () => {
    expect(run(ctx, proposed, { type: 'approveOffer', commandId: 'ok', actor: LEAD, offerId }, '18:22:00').ok).toBe(true);
  });

  it('a consult id in the message -> PHI_BLOCKED, nothing emitted', () => {
    const log = tamper((m) => m.replace('Reason: projected coverage gap.', 'Reason: CON-2105 waiting.'));
    const r = run(ctx, log, { type: 'approveOffer', commandId: 'b1', actor: LEAD, offerId }, '18:22:00');
    expect(r).toMatchObject({ ok: false, code: 'PHI_BLOCKED' });
    expect(!r.ok && r.message).toMatch(/"CON-2105" \(consult id\)/);
  });

  it('"stroke" in the message -> PHI_BLOCKED (denylist), and an off-vocabulary word -> PHI_BLOCKED (whitelist)', () => {
    const stroke = run(ctx, tamper((m) => m.replace('projected coverage gap', 'stroke backlog')), { type: 'approveOffer', commandId: 'b2', actor: LEAD, offerId }, '18:22:00');
    expect(stroke).toMatchObject({ ok: false, code: 'PHI_BLOCKED' });
    expect(!stroke.ok && stroke.message).toMatch(/"stroke" \(clinical term\)/);
    const other = run(ctx, tamper((m) => `${m}\nCall me back.`), { type: 'approveOffer', commandId: 'b3', actor: LEAD, offerId }, '18:22:00');
    expect(other).toMatchObject({ ok: false, code: 'PHI_BLOCKED' });
  });

  it('a blocked approval leaves the offer proposed: no offer_approved/sent/delivered in the log', () => {
    const log = tamper((m) => `${m} stroke`);
    const r = run(ctx, log, { type: 'approveOffer', commandId: 'b4', actor: LEAD, offerId }, '18:22:00');
    expect(r.ok).toBe(false);
    expect(log.map((e) => e.type)).toEqual(['offer_proposed']);
  });
});
