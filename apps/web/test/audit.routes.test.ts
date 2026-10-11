import { DATA_DIR, body, req } from './helpers';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTION_CSV_COLUMNS, chooseRoute, detect, findPhiViolations, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import * as actionsCsvRoute from '@/app/api/audit/actions.csv/route';
import * as auditCsvRoute from '@/app/api/audit.csv/route';
import * as commandsRoute from '@/app/api/commands/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as viewRoute from '@/app/api/view/route';
import type { CommandResponse, ViewDTO } from '@/lib/dto';
import { LEAD_COOKIE, leadCookieValue } from '@/server/auth';
import { disposeStore } from '@/server/store';

/**
 * D-88 action audit through the routes: the brief's other two interventions
 * (escalate to clinical leadership: coordinator raises, clinical lead
 * authorizes with the PIN; reassign a consult: coordinator right) show up in
 * GET /api/view and in GET /api/audit/actions.csv. Ids come from the engine
 * on the same data package, never from literals.
 */

const dataset = loadDataset(DATA_DIR);
const now1820 = snapshotAsOfMs(dataset) ?? 0;

/** An open, assigned consult that routing rules 1-4 would route to someone else at 18:20 (chooseRoute, forConsultId). */
const reassignable = (() => {
  const d = detect(dataset, now1820);
  for (const c of Object.values(d.state.consults).filter((x) => x.open && x.hospitalId !== null)) {
    const cand = chooseRoute(d.state, d.staffing, c.hospitalId ?? '', now1820, { forConsultId: c.consultId }).ranked.find((r) => r.physicianId !== c.assignedPhysicianId);
    if (cand !== undefined) return { consultId: c.consultId, hospitalId: c.hospitalId ?? '', from: c.assignedPhysicianId, to: cand.physicianId };
  }
  return null;
})();

const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));
const leadCookie = () => `${LEAD_COOKIE}=${encodeURIComponent(leadCookieValue())}`;
const command = (role: string, cmd: Record<string, unknown>) =>
  commandsRoute.POST(req('/api/commands', { method: 'POST', role, ...(role === 'clinical_lead' ? { cookie: leadCookie() } : {}), body: JSON.stringify({ command: cmd }) }));

beforeEach(async () => {
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterAll(() => disposeStore());

describe('escalate + reassign through the routes, audited (brief "Users and Decision Rights"; D-88)', () => {
  it('raise (coordinator) -> authorize (clinical lead, PIN) -> AUTHORIZED in the view; reassignment request listed; actions.csv has one line per action', async () => {
    const v0 = await view();
    expect(v0.reassignments).toEqual([]);
    expect(v0.escalations).toEqual([]);
    const rec = v0.recommendation;
    const top = v0.attention.find((a) => a.id === rec?.attentionItemId);
    expect(top).toBeDefined();

    // Escalation: the coordinator raises, the clinical lead authorizes (PIN cookie; OQ-44).
    const raised = await command('coordinator', { type: 'raiseEscalation', subject: { attentionItemId: rec?.attentionItemId, consultIds: top?.consultIds ?? [], hospitalIds: top?.hospitalIds ?? [] }, reason: 'top issue needs the clinical lead' });
    expect(raised.status).toBe(200);
    let v = await view();
    expect(v.escalations).toHaveLength(1);
    expect(v.escalations[0]).toMatchObject({ authorizedAtMs: null, raisedBy: 'coordinator:coordinator-on-duty', headline: top?.headline });
    const escalationId = v.escalations[0]?.escalationId ?? '';
    const asCoordinator = await command('coordinator', { type: 'authorizeEscalation', escalationId });
    expect(asCoordinator.status).toBe(403);
    const noPin = await commandsRoute.POST(req('/api/commands', { method: 'POST', role: 'clinical_lead', body: JSON.stringify({ command: { type: 'authorizeEscalation', escalationId } }) }));
    expect(noPin.status).toBe(401);
    expect((await command('clinical_lead', { type: 'authorizeEscalation', escalationId, note: 'cover approved' })).status).toBe(200);
    v = await view();
    expect(v.escalations[0]).toMatchObject({ escalationId, authorizedBy: 'clinical_lead:clinical-lead-on-duty', note: 'cover approved' });
    expect(v.escalations[0]?.authorizedAtMs).not.toBeNull();

    // Reassignment: a coordinator right, validated by routing, no approval step.
    expect(reassignable, 'the data package has an open consult with a routable alternative at 18:20').not.toBeNull();
    const target = reassignable ?? { consultId: '', hospitalId: '', from: null, to: '' };
    const asLead = await command('clinical_lead', { type: 'requestReassignment', consultId: target.consultId, toPhysicianId: target.to });
    expect(asLead.status).toBe(403);
    const r = await command('coordinator', { type: 'requestReassignment', consultId: target.consultId, toPhysicianId: target.to });
    expect(r.status).toBe(200);
    expect((await body<CommandResponse>(r)).emitted?.map((e) => e.type)).toEqual(['reassignment_requested']);
    v = await view();
    expect(v.reassignments).toHaveLength(1);
    expect(v.reassignments[0]).toMatchObject({ consultId: target.consultId, hospitalId: target.hospitalId, fromPhysicianId: target.from, toPhysicianId: target.to, requestedBy: 'coordinator:coordinator-on-duty', label: 'requested in Synapse' });
    expect(v.reassignments[0]?.why).not.toBe('');

    // The action audit export: pinned header, one line per action, both interventions, approval states, no PHI in detail.
    const res = await actionsCsvRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const [header, ...lines] = (await res.text()).trim().split('\n');
    expect(header).toBe(ACTION_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(v.logSeq);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`,escalation_raised,coordinator,coordinator-on-duty,${escalationId},`);
    expect(lines[0]).toContain(',authorized,');
    expect(lines[1]).toContain(`,escalation_authorized,clinical_lead,clinical-lead-on-duty,${escalationId},`);
    expect(lines[2]).toContain(`,reassignment_requested,coordinator,coordinator-on-duty,${target.consultId},`);
    expect(lines[2]).toContain(`,${target.hospitalId},${target.consultId},n/a,`);
    for (const line of lines) expect(findPhiViolations(line.split(',').at(-1) ?? ''), line).toEqual([]);
    // The offer audit (D-60) is untouched: offers only, so no row yet.
    expect((await (await auditCsvRoute.GET()).text()).trim().split('\n')).toHaveLength(1);
  });

  it('an escalation awaiting the lead reads "awaiting" in actions.csv', async () => {
    const v0 = await view();
    const top = v0.attention[0];
    expect((await command('coordinator', { type: 'raiseEscalation', subject: { consultIds: top?.consultIds ?? [], hospitalIds: top?.hospitalIds ?? [] }, reason: 'deadlock at the top issue' })).status).toBe(200);
    const lines = (await (await actionsCsvRoute.GET()).text()).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(',escalation_raised,');
    expect(lines[1]).toContain(',awaiting,');
  });
});
