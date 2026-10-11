import { describe, expect, it } from 'vitest';
import {
  ACTION_CSV_COLUMNS,
  AUDIT_CSV_COLUMNS,
  COMMAND_ROLES,
  DECISION_RIGHTS,
  REASSIGNMENT_NO_APPROVAL_NOTE,
  actionAuditRows,
  actionsCsv,
  auditCsv,
  chooseRoute,
  decide,
  detect,
  findPhiViolations,
  type ActionLog,
} from '../src';
import { COORD, LEAD, SYSTEM, ctx, dataset, delivered, must, phys } from './act.helpers';
import { et } from './helpers';

/**
 * D-88 action audit. Brief "Problem to Solve" names three interventions
 * (reassign a stranded consult, escalate to clinical leadership, offer a split
 * shift); "Users and Decision Rights" says who takes each step; "Notification
 * and Safety Constraints": "Log every offer: who was considered, who was
 * excluded and why, who approved, and the outcome." Every id below comes from
 * the engine at 18:20 on data/raw, never from a literal.
 */

const T0 = et('18:20:00');
const d0 = decide(dataset, T0);
const offeree = d0.recommendedOffer?.physicianId ?? '';
const top = d0.detection.attention[0];
const rec = d0.recommendation;

/** An open, assigned consult that routing rule 1-4 would route to someone else right now (chooseRoute, forConsultId). */
function reassignable(atMs: number): { consultId: string; hospitalId: string; from: string | null; to: string } {
  const d = detect(dataset, atMs);
  for (const c of Object.values(d.state.consults).filter((x) => x.open && x.hospitalId !== null)) {
    const hospitalId = c.hospitalId ?? '';
    const cand = chooseRoute(d.state, d.staffing, hospitalId, atMs, { forConsultId: c.consultId }).ranked.find((r) => r.physicianId !== c.assignedPhysicianId);
    if (cand !== undefined) return { consultId: c.consultId, hospitalId, from: c.assignedPhysicianId, to: cand.physicianId };
  }
  throw new Error(`no reassignable consult at ${atMs}`);
}

// 18:21 propose, 18:22 approve+send+deliver (delivered helper), 18:22:30 escalate, 18:23 authorize, 18:23:30 reassignment, 18:24 accept, 18:24:30 internal alert.
const base = delivered(ctx, offeree);
const withEsc: ActionLog = must(ctx, base.log, { type: 'raiseEscalation', commandId: 'esc', actor: COORD, subject: { attentionItemId: top?.id ?? '', consultIds: top?.consultIds ?? [], hospitalIds: top?.hospitalIds ?? [] }, reason: 'no routable candidate; split-shift offer recommended' }, '18:22:30');
const escEvent = withEsc.at(-1);
const escId = escEvent?.type === 'escalation_raised' ? escEvent.payload.escalationId : '';
const authorized = must(ctx, withEsc, { type: 'authorizeEscalation', commandId: 'auth', actor: LEAD, escalationId: escId, note: 'cover approved' }, '18:23:00');
const target = reassignable(et('18:23:30'));
const withReassign = must(ctx, authorized, { type: 'requestReassignment', commandId: 'ra', actor: COORD, consultId: target.consultId, toPhysicianId: target.to }, '18:23:30');
const accepted = must(ctx, withReassign, { type: 'respond', commandId: 'acc', actor: phys(offeree), offerId: base.offerId, physicianId: offeree, response: 'accept' }, '18:24:00');
const log: ActionLog = must(ctx, accepted, { type: 'sendInternalAlert', commandId: 'al', actor: SYSTEM, message: 'please verify presence', physicianIds: [offeree] }, '18:24:30');

const rows = actionAuditRows(log);
const ofType = (type: string) => rows.filter((r) => r.type === type);

describe('actionAuditRows: one row per action, for all three interventions (D-88)', () => {
  it('covers every event in the log, in seq order, with the actor who issued it', () => {
    expect(rows.map((r) => r.seq)).toEqual(log.map((e) => e.seq));
    expect(rows.map((r) => [r.type, r.actorRole, r.actorId])).toEqual(log.map((e) => [e.type, e.actor.role, e.actor.id]));
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['offer_proposed', 'offer_approved', 'offer_sent', 'offer_delivered', 'escalation_raised', 'escalation_authorized', 'reassignment_requested', 'offer_accepted', 'internal_alert_sent']));
  });

  it('knowledge time: rows at nowMs exclude later actions', () => {
    expect(actionAuditRows(log, et('18:22:00')).map((r) => r.type)).toEqual(['offer_proposed', 'offer_approved', 'offer_sent', 'offer_delivered']);
    expect(actionAuditRows([], T0)).toEqual([]);
  });

  it('reassign a consult: coordinator right, no approval step (brief "Users and Decision Rights" row 1)', () => {
    const [r] = ofType('reassignment_requested');
    expect(r).toMatchObject({ actorRole: DECISION_RIGHTS.REASSIGN_CONSULT.proposer, subjectId: target.consultId, hospitalIds: [target.hospitalId], consultIds: [target.consultId], approvalState: 'n/a' });
    expect(r?.physicianIds).toEqual(target.from === null ? [target.to] : [target.from, target.to]);
    expect(r?.detail).toContain(REASSIGNMENT_NO_APPROVAL_NOTE);
    expect(r?.detail).toContain('requested in Synapse');
    expect(DECISION_RIGHTS.REASSIGN_CONSULT.approver).toBeNull();
    expect(COMMAND_ROLES.requestReassignment).toEqual([r?.actorRole]);
  });

  it('escalate to clinical leadership: awaiting until the clinical lead authorizes (brief row 2)', () => {
    const before = actionAuditRows(log, et('18:22:30')).find((r) => r.type === 'escalation_raised');
    expect(before).toMatchObject({ subjectId: escId, approvalState: 'awaiting', actorRole: DECISION_RIGHTS.ESCALATE_TO_CLINICAL_LEAD.proposer, consultIds: top?.consultIds ?? [], hospitalIds: top?.hospitalIds ?? [] });
    const [raised] = ofType('escalation_raised');
    const [auth] = ofType('escalation_authorized');
    expect(raised?.approvalState).toBe('authorized');
    expect(auth).toMatchObject({ subjectId: escId, approvalState: 'authorized', actorRole: DECISION_RIGHTS.ESCALATE_TO_CLINICAL_LEAD.approver });
    expect(auth?.detail).toContain('cover approved');
    expect(raised?.detail).toContain('no routable candidate');
    expect(rec?.actions.some((a) => a.kind === 'ESCALATE_TO_CLINICAL_LEAD')).toBe(true);
  });

  it('split-shift offer: awaiting at proposal, approved once the clinical lead approves; the physician accepts', () => {
    const atProposal = actionAuditRows(log, et('18:21:00'));
    expect(atProposal).toHaveLength(1);
    expect(atProposal[0]).toMatchObject({ type: 'offer_proposed', subjectId: base.offerId, approvalState: 'awaiting', actorRole: DECISION_RIGHTS.SPLIT_SHIFT_OFFER.proposer, physicianIds: [offeree] });
    expect(ofType('offer_proposed')[0]?.approvalState).toBe('approved');
    expect(ofType('offer_approved')[0]).toMatchObject({ approvalState: 'approved', actorRole: DECISION_RIGHTS.SPLIT_SHIFT_OFFER.approver, physicianIds: [offeree] });
    expect(ofType('offer_sent')[0]?.actorRole).toBe('system');
    expect(ofType('offer_accepted')[0]).toMatchObject({ actorRole: 'physician', actorId: offeree, approvalState: 'approved' });
    expect(ofType('offer_accepted')[0]?.detail).toMatch(/accepted by .*: online from \d\d:\d\d:\d\d until \d\d:\d\d:\d\d ET; \d+ needs? filled/);
    const proposed = log.find((e) => e.type === 'offer_proposed');
    const scope = proposed?.type === 'offer_proposed' ? proposed.payload.routingScope : [];
    expect(ofType('offer_proposed')[0]?.hospitalIds).toEqual(scope);
  });

  it('a rejected offer reads rejected on every one of its rows', () => {
    let l: ActionLog = must(ctx, [], { type: 'proposeOffer', commandId: 'p2', actor: COORD, physicianId: offeree }, '18:21:00');
    const offerId = l.at(-1)?.type === 'offer_proposed' ? (l.at(-1) as Extract<ActionLog[number], { type: 'offer_proposed' }>).payload.offerId : '';
    l = must(ctx, l, { type: 'rejectOffer', commandId: 'rj', actor: LEAD, offerId, reason: 'hold for now' }, '18:22:00');
    expect(actionAuditRows(l).map((r) => [r.type, r.approvalState])).toEqual([
      ['offer_proposed', 'rejected'],
      ['offer_rejected', 'rejected'],
    ]);
  });

  it('internal alert: the brief\'s permitted automation, no approval', () => {
    expect(ofType('internal_alert_sent')[0]).toMatchObject({ actorRole: 'system', approvalState: 'n/a', physicianIds: [offeree] });
    expect(ofType('internal_alert_sent')[0]?.detail).toContain('automated');
  });

  it('no PHI in any detail line (brief "No patient information"): the engine\'s guard finds nothing', () => {
    for (const r of rows) expect(findPhiViolations(r.detail), `${r.type}: ${r.detail}`).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(9);
  });
});

describe('actionsCsv (D-88) and the untouched offer audit CSV (D-60)', () => {
  it('pinned header, one line per action, seq and approval state in the right columns', () => {
    const csv = actionsCsv(log);
    const [header, ...lines] = csv.trim().split('\n');
    expect(header).toBe('seq,at,type,actor_role,actor_id,subject_id,physician_ids,hospital_ids,consult_ids,approval_state,detail');
    expect(header?.split(',')).toEqual([...ACTION_CSV_COLUMNS]);
    expect(lines).toHaveLength(log.length);
    expect(lines[0]?.startsWith(`1,2026-03-17T18:21:00-04:00,offer_proposed,coordinator,${COORD.id},${base.offerId},${offeree},`)).toBe(true);
    const ra = lines.find((l) => l.includes(',reassignment_requested,'));
    expect(ra).toContain(`,coordinator,${COORD.id},${target.consultId},`);
    expect(ra).toContain(`,${target.hospitalId},${target.consultId},n/a,`);
    expect(lines.find((l) => l.includes(',escalation_raised,'))).toContain(`,${escId},`);
    expect(actionsCsv(log, et('18:22:00')).trim().split('\n')).toHaveLength(5);
    expect(actionsCsv(log)).toBe(actionsCsv(log));
  });

  it('auditCsv is unchanged: same 27 pinned columns, still one row per offer', () => {
    const before = auditCsv(base.log);
    const csv = auditCsv(log);
    const [header, ...offersRows] = csv.trim().split('\n');
    expect(header).toBe(AUDIT_CSV_COLUMNS.join(','));
    expect(header?.split(',')).toHaveLength(27);
    expect(offersRows).toHaveLength(1);
    expect(before.trim().split('\n')[0]).toBe(header);
    expect(before.trim().split('\n')).toHaveLength(2);
    expect(csv).not.toContain('reassignment_requested');
  });
});
