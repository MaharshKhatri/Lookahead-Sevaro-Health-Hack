import { describe, expect, it } from 'vitest';
import { DECISION_RIGHTS } from '../src';
import { decision1820 } from './decide.helpers';

const r = decision1820();
const byKindTarget = (kind: string, consultId: string) => r.interventions.find((i) => i.kind === kind && i.targets.consultIds.includes(consultId));

describe('Interventions (brief "Problem to Solve" Decide + "Users and Decision Rights")', () => {
  it('decision rights: coordinator proposes; clinical lead approves escalations and offers; the off-shift physician accepts offers', () => {
    expect(DECISION_RIGHTS.SPLIT_SHIFT_OFFER).toEqual({ proposer: 'coordinator', approver: 'clinical_lead', acceptor: 'off_shift_physician', automationAllowed: false });
    expect(DECISION_RIGHTS.ESCALATE_TO_CLINICAL_LEAD).toMatchObject({ proposer: 'coordinator', approver: 'clinical_lead' });
    for (const i of r.interventions) expect([i.proposer, i.approver, i.acceptor, i.automationAllowed]).toEqual(Object.values(DECISION_RIGHTS[i.kind]));
  });

  it('automationAllowed is true only for internal coordinator alerts (VERIFY_PRESENCE)', () => {
    expect([...new Set(r.interventions.filter((i) => i.automationAllowed).map((i) => i.kind))]).toEqual(['VERIFY_PRESENCE']);
    for (const i of r.interventions.filter((x) => x.kind === 'VERIFY_PRESENCE')) expect(i.expectedEffect).toMatch(/Internal alert to the coordinator/);
  });

  it('CON-2110 reassign: "no routable candidate" (routing rule 5) -> falls through to escalation', () => {
    const re = byKindTarget('REASSIGN_CONSULT', 'CON-2110');
    expect(re).toMatchObject({ candidates: [], expectedEffect: 'No routable candidate: fall through to escalation.' });
    expect(re?.why[0]).toBe('Reassign CON-2110 (Stroke, Assigned) at Harbor Regional: no routable candidate (routing rule 5).');
    expect(byKindTarget('ESCALATE_TO_CLINICAL_LEAD', 'CON-2110')).toBeDefined();
  });

  it('top-issue recommendation: CON-2105 deadlock -> no reassignment candidate -> escalate + split-shift offer to PHY-009, scoped and seeded', () => {
    const rec = r.recommendation;
    expect(rec?.headline).toBe('CON-2105 Stroke at Oak Valley Medical: no routable physician');
    expect(rec?.attentionItemId).toBe(r.detection.attention[0]?.id);
    expect(rec?.actions.map((a) => a.kind)).toEqual(['REASSIGN_CONSULT', 'ESCALATE_TO_CLINICAL_LEAD', 'SPLIT_SHIFT_OFFER']);
    expect(rec?.actions[0]?.candidates).toEqual([]);
    expect(rec?.actions[2]?.targets).toEqual({ consultIds: [], physicianIds: ['PHY-009'], hospitalIds: ['SYN-005', 'SYN-008', 'SYN-010'] });
    expect(rec?.rationale[3]).toMatch(/^Split-shift offer to Dr\. Grace Okafor \(PHY-009\), 18:35-22:35 ET, scope SYN-005, SYN-008, SYN-010, seeded at 14 consults/);
  });

  it('every one of the top 5 attention items has at least one intervention', () => {
    for (const a of r.detection.attention.slice(0, 5)) expect(r.interventions.some((i) => i.linkedAttentionIds.includes(a.id)), a.headline).toBe(true);
  });

  it('imaging pending (CON-2102) escalates only: imaging is a hospital-side step, not a physician reassignment', () => {
    expect(r.interventions.filter((i) => i.targets.consultIds.includes('CON-2102')).map((i) => i.kind)).toEqual(['ESCALATE_TO_CLINICAL_LEAD']);
  });

  it('open notes: one NOTE_HANDOFF_PLAN per physician (PHY-003: CON-2111, CON-2115 before the 19:00 shift end)', () => {
    const notes = r.interventions.filter((i) => i.kind === 'NOTE_HANDOFF_PLAN');
    expect(notes.map((i) => [i.targets.physicianIds, i.targets.consultIds])).toEqual([[['PHY-003'], ['CON-2111', 'CON-2115']]]);
    expect(notes[0]?.expectedEffect).toMatch(/before shift end 19:00 ET/);
  });

  it('AT_RISK needs produce a presence check on each expected arrival (PHY-011, PHY-012), never an offer', () => {
    expect(r.interventions.filter((i) => i.kind === 'VERIFY_PRESENCE').map((i) => i.targets.physicianIds[0])).toEqual(['PHY-011', 'PHY-012']);
    const atRiskIds = new Set(r.needs.filter((n) => n.kind === 'AT_RISK').map((n) => n.id));
    for (const i of r.interventions.filter((x) => x.kind === 'SPLIT_SHIFT_OFFER')) expect(i.linkedNeedIds.some((id) => !atRiskIds.has(id))).toBe(true);
  });

  it('ids are unique; every intervention explains itself', () => {
    expect(new Set(r.interventions.map((i) => i.id)).size).toBe(r.interventions.length);
    for (const i of r.interventions) {
      expect(i.why.length).toBeGreaterThan(0);
      expect(i.expectedEffect.length).toBeGreaterThan(0);
    }
  });
});
