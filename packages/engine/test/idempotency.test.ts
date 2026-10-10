import { describe, expect, it } from 'vitest';
import { COORD, LEAD, ctx, must, offerIdOf, phys, run } from './act.helpers';

// Idempotency key = commandId: a retried command returns its original result and appends nothing.
describe('idempotency', () => {
  const proposed = must(ctx, [], { type: 'proposeOffer', commandId: 'p', actor: COORD, physicianId: 'PHY-009' }, '18:21:00');
  const offerId = offerIdOf(proposed, 'PHY-009');

  it('the same proposeOffer commandId twice: same events, replayed: true, log unchanged', () => {
    const again = run(ctx, proposed, { type: 'proposeOffer', commandId: 'p', actor: COORD, physicianId: 'PHY-009' }, '18:21:30');
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(again.ok && again.log).toBe(proposed);
    expect(again.ok && again.emitted).toEqual(proposed);
  });

  it('approval (3 events) and acceptance (with coverage) replay identically', () => {
    const a1 = run(ctx, proposed, { type: 'approveOffer', commandId: 'a', actor: LEAD, offerId }, '18:22:00');
    if (!a1.ok) throw new Error(a1.message);
    const a2 = run(ctx, a1.log, { type: 'approveOffer', commandId: 'a', actor: LEAD, offerId }, '18:22:10');
    expect(a2.ok && [a2.replayed, a2.emitted, a2.log.length]).toEqual([true, a1.emitted, 4]);
    const r1 = run(ctx, a1.log, { type: 'respond', commandId: 'r', actor: phys('PHY-009'), offerId, physicianId: 'PHY-009', response: 'accept' }, '18:24:00');
    if (!r1.ok) throw new Error(r1.message);
    const r2 = run(ctx, r1.log, { type: 'respond', commandId: 'r', actor: phys('PHY-009'), offerId, physicianId: 'PHY-009', response: 'accept' }, '18:25:00');
    expect(r2.ok && [r2.replayed, r2.log.length]).toEqual([true, 5]);
    expect(r2.ok && r2.coverage).toEqual(r1.coverage);
  });

  it('ids are deterministic hashes of the commandId; a new commandId is a new command (here refused: OPEN_OFFER_EXISTS)', () => {
    expect(proposed[0]?.actionId).toMatch(/^act-[0-9a-f]{8}$/);
    expect(must(ctx, [], { type: 'proposeOffer', commandId: 'p', actor: COORD, physicianId: 'PHY-009' }, '18:21:00')[0]?.actionId).toBe(proposed[0]?.actionId);
    expect(run(ctx, proposed, { type: 'proposeOffer', commandId: 'p-new', actor: COORD, physicianId: 'PHY-009' }, '18:21:30')).toMatchObject({ ok: false, code: 'OPEN_OFFER_EXISTS' });
  });

  it('a failed command stores nothing, so its retry is evaluated afresh', () => {
    const f1 = run(ctx, proposed, { type: 'approveOffer', commandId: 'bad', actor: COORD, offerId }, '18:22:00');
    expect(f1).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
    expect(run(ctx, proposed, { type: 'approveOffer', commandId: 'bad', actor: LEAD, offerId }, '18:22:00').ok).toBe(true);
  });

  it('the log is append-only in sim time: a command dated before the last action -> INVALID_STATE', () => {
    expect(run(ctx, proposed, { type: 'approveOffer', commandId: 'early', actor: LEAD, offerId }, '18:20:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it('unknown offer -> UNKNOWN_OFFER', () => {
    expect(run(ctx, proposed, { type: 'approveOffer', commandId: 'u', actor: LEAD, offerId: 'off-nope' }, '18:22:00')).toMatchObject({ ok: false, code: 'UNKNOWN_OFFER' });
  });
});
