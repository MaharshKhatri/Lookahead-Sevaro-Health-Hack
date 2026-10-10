import { describe, expect, it } from 'vitest';
import { actionsKnownAt, diffSnapshot, replay, toSnapshotConsultRows, toSnapshotPhysicianRows, type ActionLog } from '../src';
import { COORD, LEAD, ctx, dataset, must, offerIdOf, phys } from './act.helpers';
import { et } from './helpers';

// The action log is ours and separate from Sevaro's event stream (brief "Synthetic Dataset"; CLAUDE.md rule 2).
let log: ActionLog = must(ctx, [], { type: 'proposeOffer', commandId: 'p', actor: COORD, physicianId: 'PHY-009' }, '18:21:00');
const offerId = offerIdOf(log, 'PHY-009');
log = must(ctx, log, { type: 'approveOffer', commandId: 'a', actor: LEAD, offerId }, '18:22:00');
log = must(ctx, log, { type: 'respond', commandId: 'r', actor: phys('PHY-009'), offerId, physicianId: 'PHY-009', response: 'accept' }, '18:24:00');
log = must(ctx, log, { type: 'raiseEscalation', commandId: 'e', actor: COORD, subject: { consultIds: ['CON-2105'] }, reason: 'deadlock' }, '18:25:00');

describe('isolation: Sevaro replay is unaffected by any action log', () => {
  it('replay at 18:20 still reproduces the snapshot 8/8 and 18/18 with an action log present', () => {
    const state = replay(dataset, et('18:20:00'));
    const result = diffSnapshot({ physicians: toSnapshotPhysicianRows(state), consults: toSnapshotConsultRows(state) }, dataset.snapshot!);
    expect(result.summary).toEqual({ physicians: '8/8 rows match', consults: '18/18 rows match' });
    expect(log.length).toBe(6);
  });

  it('commands never mutate the dataset or the input log', () => {
    expect(dataset.events.length).toBe(1164);
    expect(Object.isFrozen(log)).toBe(true);
    const before = log.length;
    must(ctx, log, { type: 'sendInternalAlert', commandId: 'x', actor: COORD, message: 'check PHY-011' }, '18:26:00');
    expect(log.length).toBe(before);
  });

  it('knowledge time: actionsKnownAt(log, 18:22) holds only what was applied by 18:22', () => {
    expect(actionsKnownAt(log, et('18:22:00')).map((e) => e.type)).toEqual(['offer_proposed', 'offer_approved', 'offer_sent', 'offer_delivered']);
    expect(actionsKnownAt(log, et('18:20:59'))).toEqual([]);
  });

  it('accepting does not alter Sevaro state: CON-2105 is still unassigned in replay(18:40); coverage changes only via decide(acceptedOffers)', () => {
    expect(replay(dataset, et('18:40:00')).consults['CON-2105']?.assignedPhysicianId).toBeNull();
  });
});
