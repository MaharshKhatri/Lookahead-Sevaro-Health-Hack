import { describe, expect, it } from 'vitest';
import { COMMAND_ROLES, DECISION_RIGHTS, type ActionLog, type ActorRef, type Command, type CommandType, type Role } from '../src';
import { COORD, LEAD, ctx, delivered, must, phys, run, SYSTEM } from './act.helpers';

// Brief "Users and Decision Rights": coordinator proposes / reassigns; clinical lead approves offers and authorizes
// escalations; off-shift physician accepts or declines "from a phone; nothing else"; automation only for internal alerts.
const ROLES: readonly Role[] = ['coordinator', 'clinical_lead', 'physician', 'system'];
const actorFor = (role: Role): ActorRef => (role === 'physician' ? phys('PHY-009') : role === 'coordinator' ? COORD : role === 'clinical_lead' ? LEAD : SYSTEM);

// Fixture: a delivered offer to PHY-009, a raised escalation.
const base = delivered(ctx, 'PHY-009');
const withEsc: ActionLog = must(ctx, base.log, { type: 'raiseEscalation', commandId: 'esc', actor: COORD, subject: { consultIds: ['CON-2105'] }, reason: 'deadlock' }, '18:22:30');
const escId = withEsc.at(-1)?.type === 'escalation_raised' ? (withEsc.at(-1) as Extract<ActionLog[number], { type: 'escalation_raised' }>).payload.escalationId : '';

const commandFor = (type: CommandType, actor: ActorRef, i: number): Command => {
  const b = { commandId: `m-${type}-${actor.role}-${i}`, actor };
  switch (type) {
    case 'proposeOffer':
      return { ...b, type, physicianId: 'PHY-009' };
    case 'proposeSlot':
      return { ...b, type };
    case 'approveOffer':
      return { ...b, type, offerId: base.offerId };
    case 'rejectOffer':
      return { ...b, type, offerId: base.offerId };
    case 'respond':
      return { ...b, type, offerId: base.offerId, physicianId: 'PHY-009', response: 'decline' };
    case 'cancelOffer':
      return { ...b, type, offerId: base.offerId, reason: 'test' };
    case 'tick':
      return { ...b, type };
    case 'raiseEscalation':
      return { ...b, type, subject: { consultIds: ['CON-2105'] }, reason: 'test' };
    case 'authorizeEscalation':
      return { ...b, type, escalationId: escId };
    case 'requestReassignment':
      return { ...b, type, consultId: 'CON-2102', toPhysicianId: 'PHY-004' };
    case 'sendInternalAlert':
      return { ...b, type, message: 'verify presence', physicianIds: ['PHY-011'] };
  }
};

describe('role enforcement: every command x every role (FORBIDDEN_ROLE exactly where DECISION_RIGHTS says)', () => {
  it('COMMAND_ROLES is derived from DECISION_RIGHTS', () => {
    expect(COMMAND_ROLES).toEqual({
      proposeOffer: ['coordinator'],
      proposeSlot: ['coordinator'],
      approveOffer: ['clinical_lead'],
      rejectOffer: ['clinical_lead'],
      respond: ['physician'],
      cancelOffer: ['coordinator', 'clinical_lead'],
      tick: ['system'],
      raiseEscalation: ['coordinator'],
      authorizeEscalation: ['clinical_lead'],
      requestReassignment: ['coordinator'],
      sendInternalAlert: ['system', 'coordinator'],
    });
    expect(DECISION_RIGHTS.SPLIT_SHIFT_OFFER).toMatchObject({ proposer: 'coordinator', approver: 'clinical_lead', acceptor: 'off_shift_physician' });
    expect(DECISION_RIGHTS.VERIFY_PRESENCE.automationAllowed).toBe(true);
  });

  const types = Object.keys(COMMAND_ROLES) as CommandType[];
  for (const type of types) {
    for (const role of ROLES) {
      const allowed = COMMAND_ROLES[type].includes(role);
      it(`${type} by ${role}: ${allowed ? 'allowed' : 'FORBIDDEN_ROLE'}`, () => {
        const r = run(ctx, withEsc, commandFor(type, actorFor(role), 0), '18:23:00');
        if (allowed) expect(r.ok ? 'ok' : r.code).not.toBe('FORBIDDEN_ROLE');
        else expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
      });
    }
  }

  it('allowed commands succeed on the fixture (role is the only gate here)', () => {
    const ok = (c: Command) => run(ctx, withEsc, c, '18:23:00').ok;
    expect(ok(commandFor('approveOffer', LEAD, 1))).toBe(false); // already delivered: INVALID_STATE, not a role problem
    expect(ok(commandFor('respond', phys('PHY-009'), 1))).toBe(true);
    expect(ok(commandFor('cancelOffer', COORD, 1))).toBe(true);
    expect(ok(commandFor('cancelOffer', LEAD, 2))).toBe(true);
    expect(ok(commandFor('authorizeEscalation', LEAD, 1))).toBe(true);
    expect(ok(commandFor('requestReassignment', COORD, 1))).toBe(true);
    expect(ok(commandFor('sendInternalAlert', SYSTEM, 1))).toBe(true);
    expect(ok(commandFor('sendInternalAlert', COORD, 2))).toBe(true);
  });

  it('a physician cannot act on another physician\'s offer (NOT_OWN_OFFER), even naming the right physicianId', () => {
    expect(run(ctx, withEsc, { type: 'respond', commandId: 'x1', actor: phys('PHY-014'), offerId: base.offerId, physicianId: 'PHY-014', response: 'accept' }, '18:23:00')).toMatchObject({ ok: false, code: 'NOT_OWN_OFFER' });
    expect(run(ctx, withEsc, { type: 'respond', commandId: 'x2', actor: phys('PHY-014'), offerId: base.offerId, physicianId: 'PHY-009', response: 'accept' }, '18:23:00')).toMatchObject({ ok: false, code: 'NOT_OWN_OFFER' });
  });

  it('only a system-issued internal alert is marked automated', () => {
    const sys = run(ctx, withEsc, commandFor('sendInternalAlert', SYSTEM, 3), '18:23:00');
    const coord = run(ctx, withEsc, commandFor('sendInternalAlert', COORD, 4), '18:23:00');
    const flag = (r: typeof sys) => (r.ok && r.emitted[0]?.type === 'internal_alert_sent' ? r.emitted[0].payload.automated : null);
    expect([flag(sys), flag(coord)]).toEqual([true, false]);
  });

  it('reassignment is recorded as "requested in Synapse" and validated by routing (PHY-004 routable at SYN-009; PHY-001 is not)', () => {
    const r = run(ctx, withEsc, commandFor('requestReassignment', COORD, 5), '18:23:00');
    expect(r.ok && r.emitted[0]?.type === 'reassignment_requested' && r.emitted[0].payload).toMatchObject({ consultId: 'CON-2102', fromPhysicianId: 'PHY-003', toPhysicianId: 'PHY-004', label: 'requested in Synapse' });
    const bad = run(ctx, withEsc, { type: 'requestReassignment', commandId: 'rb', actor: COORD, consultId: 'CON-2102', toPhysicianId: 'PHY-001' }, '18:23:00');
    expect(bad).toMatchObject({ ok: false, code: 'NOT_ELIGIBLE' });
    expect(!bad.ok && bad.message).toMatch(/camera active/);
  });

  it('escalations: authorize once; a second authorization or an unknown id is INVALID_STATE', () => {
    const l = must(ctx, withEsc, { type: 'authorizeEscalation', commandId: 'auth-1', actor: LEAD, escalationId: escId }, '18:23:00');
    expect(run(ctx, l, { type: 'authorizeEscalation', commandId: 'auth-2', actor: LEAD, escalationId: escId }, '18:23:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(run(ctx, l, { type: 'authorizeEscalation', commandId: 'auth-3', actor: LEAD, escalationId: 'esc-nope' }, '18:23:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });
});
