import type { ActionLog } from '../act/types';
import { foldStandbys, standbyStatus } from '../act/standby';
import { foldOffers, statusOf, expiresAt } from '../act/offers';
import type { DecisionReport } from '../decide';
import { DECISION_RIGHTS, type Actor } from '../decide/brief-rules';
import type { Intervention } from '../decide/types';
import type { AttentionItem } from '../detect/attention';
import { etClock } from '../detect/staffing';
import type { SurgeForecast } from '../forecast';
import {
  NBA_COORDINATOR_MINUTES,
  NBA_DEFAULT_PROTECTED_MIN,
  NBA_GENERAL_NEURO_WEIGHT,
  NBA_SUCCESS_PROBABILITY,
  REWIND_LATENCY_MIN,
  STANDBY_APPROVAL_LATENCY_MIN,
  TIMELINE_GAP_BAND_PGAP,
  TIMELINE_HORIZON_MIN,
  TIMELINE_SURGE_BAND_PSPIKE,
} from '../policy';
import { compareIds } from '../replay/derive';
import type { EventRef } from '../replay/types';
import type { StandbyPlan } from '../standby';
import type { Dataset, EpochMs } from '../types';
import { fnv1a } from '../util/hash';

/**
 * Coordinator intelligence (Phase 6): incidents (root-cause grouping of
 * attention items), the 180-min horizon timeline and the next-best-action
 * queue. Everything is derived from decide(), the surge forecast, the standby
 * plan and the action log; nothing re-evaluates a brief rule. Brief: "Detect
 * and rank what needs attention, and explain why each item was flagged";
 * "Recommend an intervention for the top issue".
 */

export type IncidentKind = 'HOSPITAL_SURGE' | 'ROUTING_DEADLOCK' | 'PHYSICIAN_UNAVAILABLE_WITH_ASSIGNED' | 'SHIFT_END_OPEN_NOTES' | 'COVERAGE_GAP' | 'SIGNAL_CONTRADICTION' | 'STANDALONE';

export interface Incident {
  readonly id: string;
  readonly kind: IncidentKind;
  readonly headline: string;
  readonly severity: AttentionItem['severity'];
  readonly score: number;
  readonly strokeAtRisk: boolean;
  readonly hospitalIds: readonly string[];
  readonly physicianIds: readonly string[];
  readonly consultIds: readonly string[];
  /** Attention item ids in this incident; the anchor (highest score) first. */
  readonly memberItemIds: readonly string[];
  readonly anchorItemId: string;
  /** The rule that linked the members, in plain English. */
  readonly linkRule: string;
  readonly recommendedAction: NextBestAction | null;
  readonly because: readonly EventRef[];
}

export type NbaKind = 'REASSIGN_CONSULT' | 'ESCALATE_TO_CLINICAL_LEAD' | 'SPLIT_SHIFT_OFFER' | 'STANDBY_PREALERT' | 'NOTE_HANDOFF_PLAN' | 'VERIFY_PRESENCE';

export interface NextBestAction {
  readonly id: string;
  readonly rank: number;
  readonly kind: NbaKind;
  readonly title: string;
  readonly detail: string;
  readonly proposer: Actor;
  readonly approver: Actor | null;
  readonly acceptor: Actor | null;
  /** The command the one-click "Propose" sends (POST /api/commands body.command without commandId). */
  readonly command: Readonly<Record<string, unknown>>;
  readonly expectedStrokeMinutesAverted: number;
  readonly coordinatorMinutes: number;
  readonly pSuccess: number;
  /** averted / coordinator minutes. */
  readonly score: number;
  readonly why: readonly string[];
  readonly hospitalIds: readonly string[];
  readonly physicianIds: readonly string[];
  readonly consultIds: readonly string[];
  readonly linkedIncidentIds: readonly string[];
  readonly linkedAttentionIds: readonly string[];
  /** Latest instant to propose so the relief is online before the first covered gap, when applicable. */
  readonly proposeByMs: EpochMs | null;
}

export interface TimelineItem {
  readonly kind: 'shift_end' | 'arrival_confirmed' | 'arrival_expected' | 'surge_band' | 'gap_band' | 'offer_expiry' | 'standby_expiry' | 'action_deadline' | 'now';
  readonly tMs: EpochMs;
  readonly endMs: EpochMs | null;
  readonly hospitalId: string | null;
  readonly physicianId: string | null;
  readonly label: string;
  readonly detail: string;
  readonly value: number | null;
}

export interface CoordinatorIntel {
  readonly schemaVersion: '1.0';
  readonly asOfMs: EpochMs;
  readonly incidents: readonly Incident[];
  readonly reduction: { readonly items: number; readonly incidents: number; readonly standalone: number; readonly percent: number };
  readonly timeline: { readonly fromMs: EpochMs; readonly toMs: EpochMs; readonly items: readonly TimelineItem[] };
  readonly nextBestActions: readonly NextBestAction[];
}

export interface IntelInput {
  readonly dataset: Dataset;
  readonly decision: DecisionReport;
  readonly forecast: SurgeForecast;
  readonly plan: StandbyPlan;
  readonly log: ActionLog;
  readonly nowMs: EpochMs;
}

const MIN = 60_000;
const r1 = (x: number) => Math.round(x * 10) / 10;

export function buildCoordinatorIntel(input: IntelInput): CoordinatorIntel {
  const incidents = buildIncidents(input);
  const actions = rankActions(input, incidents);
  const withActions = incidents.map((inc) => ({ ...inc, recommendedAction: actions.find((a) => a.linkedIncidentIds.includes(inc.id)) ?? null }));
  const items = input.decision.detection.attention.length;
  return {
    schemaVersion: '1.0',
    asOfMs: input.nowMs,
    incidents: withActions,
    reduction: { items, incidents: incidents.length, standalone: incidents.filter((i) => i.kind === 'STANDALONE').length, percent: items === 0 ? 0 : Math.round((1 - incidents.length / items) * 100) },
    timeline: buildTimeline(input),
    nextBestActions: actions,
  };
}

// ---------------------------------------------------------------- incidents

export function buildIncidents(input: IntelInput): Incident[] {
  const { decision } = input;
  const det = decision.detection;
  const items = det.attention;
  const taken = new Set<string>();
  const out: Incident[] = [];
  const name = (h: string) => det.staffing.hospitalNames.get(h) ?? h;
  const who = (p: string) => det.staffing.physicianNames.get(p) ?? p;
  const consultsAt = (h: string) => new Set(Object.values(det.state.consults).filter((c) => c.open && c.hospitalId === h).map((c) => c.consultId));
  const claim = (members: AttentionItem[], kind: IncidentKind, headline: string, linkRule: string, hospitalIds: string[], physicianIds: string[]) => {
    const fresh = members.filter((m) => !taken.has(m.id));
    if (fresh.length === 0) return;
    for (const m of fresh) taken.add(m.id);
    const sorted = [...fresh].sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
    const anchor = sorted[0] as AttentionItem;
    out.push({
      id: `inc-${fnv1a(`${kind}|${sorted.map((m) => m.id).join(',')}`)}`,
      kind,
      headline,
      severity: anchor.severity,
      score: anchor.score,
      strokeAtRisk: sorted.some((m) => m.strokeAtRisk),
      hospitalIds: [...new Set([...hospitalIds, ...sorted.flatMap((m) => m.hospitalIds)])].sort(compareIds),
      physicianIds: [...new Set([...physicianIds, ...sorted.flatMap((m) => m.physicianIds)])].sort(compareIds),
      consultIds: [...new Set(sorted.flatMap((m) => m.consultIds))].sort(compareIds),
      memberItemIds: sorted.map((m) => m.id),
      anchorItemId: anchor.id,
      linkRule,
      recommendedAction: null,
      because: dedupe(sorted.flatMap((m) => m.because)),
    });
  };

  // Rule 1: hospital surge + credentialed capacity exhausted -> unassigned consults, deadlocks, breaches and gaps at that hospital.
  for (const spike of items.filter((i) => i.kind === 'DEMAND_SPIKE')) {
    const h = spike.hospitalIds[0] ?? '';
    const here = consultsAt(h);
    const members = items.filter((i) => i.id === spike.id || ((i.kind === 'ROUTING_DEADLOCK' || i.kind === 'COVERAGE_GAP') && i.hospitalIds.includes(h)) || ((i.kind === 'STANDARD_BREACH' || i.kind === 'IMMINENT_BREACH') && i.consultIds.some((c) => here.has(c) && det.state.consults[c]?.assignedPhysicianId === null)));
    const routable = det.coverage.routableNow[h] ?? 0;
    claim(members, 'HOSPITAL_SURGE', `${name(h)}: surge with credentialed capacity exhausted (${members.length} items)`, `same hospital as the demand spike (${spike.headline}); routable-now count ${routable}: unassigned consults, deadlocks, breaches and coverage gaps there share the cause`, [h], []);
  }
  // Rule 1b: a routing deadlock and the time-standard breaches of the same stranded consult are one incident.
  for (const dl of items.filter((i) => i.kind === 'ROUTING_DEADLOCK' && !taken.has(i.id))) {
    const c = dl.consultIds[0] ?? '';
    const members = items.filter((i) => i.id === dl.id || ((i.kind === 'STANDARD_BREACH' || i.kind === 'IMMINENT_BREACH') && i.consultIds.includes(c)));
    claim(members, 'ROUTING_DEADLOCK', `${c}: stranded at ${name(dl.hospitalIds[0] ?? '')} (deadlock + ${members.length - 1} standard breach${members.length === 2 ? '' : 'es'})`, `the same unassigned consult: routing rule 5 found nobody eligible, so its triage clock keeps running (brief hidden situation 1)`, dl.hospitalIds.slice(), []);
  }
  // Rule 2: a physician Temporarily Unavailable with consults still assigned -> breaches on those consults.
  for (const sig of items.filter((i) => i.kind === 'SIGNAL_CONFLICT' && /Temporarily Unavailable/.test(i.headline))) {
    const p = sig.physicianIds[0] ?? '';
    const mine = new Set(sig.consultIds);
    const members = items.filter((i) => i.id === sig.id || ((i.kind === 'STANDARD_BREACH' || i.kind === 'IMMINENT_BREACH') && i.consultIds.some((c) => mine.has(c))));
    claim(members, 'PHYSICIAN_UNAVAILABLE_WITH_ASSIGNED', `${who(p)} unavailable with ${sig.consultIds.join(', ')} still assigned`, `the breaching consults are assigned to the physician who self-reported Temporarily Unavailable (brief hidden situation 4)`, [], [p]);
  }
  // Rule 3: shift end with open notes -> the note-completion breaches of that physician.
  for (const notes of items.filter((i) => i.kind === 'OPEN_NOTES_NEAR_SHIFT_END')) {
    const p = notes.physicianIds[0] ?? '';
    const mine = new Set(notes.consultIds);
    const members = items.filter((i) => i.id === notes.id || ((i.kind === 'STANDARD_BREACH' || i.kind === 'IMMINENT_BREACH') && i.consultIds.some((c) => mine.has(c))));
    claim(members, 'SHIFT_END_OPEN_NOTES', `${who(p)}: ${notes.consultIds.length} open note(s) at shift end`, `note-completion breaches on consults whose physician's shift ends within 60 min (brief Operational Standards, last row)`, [], [p]);
  }
  // Rule 4: coverage gaps at one hospital (not already part of a surge incident).
  for (const h of [...new Set(items.filter((i) => i.kind === 'COVERAGE_GAP' && !taken.has(i.id)).flatMap((i) => i.hospitalIds))].sort(compareIds)) {
    const members = items.filter((i) => i.kind === 'COVERAGE_GAP' && i.hospitalIds.includes(h));
    claim(members, 'COVERAGE_GAP', `${name(h)}: projected coverage gap`, 'coverage gaps at the same hospital over the horizon (shift ends and block changes)', [h], []);
  }
  // Rule 5: remaining signal contradictions stand alone, one per physician signal.
  for (const sig of items.filter((i) => i.kind === 'SIGNAL_CONFLICT' && !taken.has(i.id))) claim([sig], 'SIGNAL_CONTRADICTION', sig.headline, 'a physician signal that contradicts routing assumptions (brief: Availability is inferred)', [], sig.physicianIds.slice());
  // Everything else stands alone.
  for (const i of items.filter((x) => !taken.has(x.id))) claim([i], 'STANDALONE', i.headline, 'no shared cause with another item', [], []);
  return out.sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
}

function dedupe(refs: readonly EventRef[]): EventRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.eventId) ? false : (seen.add(r.eventId), true)));
}

// ---------------------------------------------------------------- timeline

export function buildTimeline(input: IntelInput): CoordinatorIntel['timeline'] {
  const { decision, forecast, plan, log, nowMs } = input;
  const det = decision.detection;
  const toMs = nowMs + TIMELINE_HORIZON_MIN * MIN;
  const name = (h: string) => det.staffing.hospitalNames.get(h) ?? h;
  const who = (p: string) => det.staffing.physicianNames.get(p) ?? p;
  const items: TimelineItem[] = [{ kind: 'now', tMs: nowMs, endMs: null, hospitalId: null, physicianId: null, label: 'now', detail: `${etClock(nowMs)} ET`, value: null }];
  for (const s of det.staffing.shifts) {
    if (s.source === 'on_shift_roster' && s.endMs > nowMs && s.endMs <= toMs) items.push({ kind: 'shift_end', tMs: s.endMs, endMs: null, hospitalId: null, physicianId: s.physicianId, label: `${who(s.physicianId)} shift ends`, detail: `${etClock(s.endMs)} ET`, value: null });
    if (s.source !== 'on_shift_roster' && s.startMs > nowMs && s.startMs <= toMs) {
      items.push({ kind: s.confirmation === 'confirmed' ? 'arrival_confirmed' : 'arrival_expected', tMs: s.startMs, endMs: null, hospitalId: null, physicianId: s.physicianId, label: `${who(s.physicianId)} ${s.source === 'split_shift_offer' ? 'split shift' : 'scheduled shift'} starts`, detail: `${etClock(s.startMs)} ET, ${s.confirmation} (OQ-29)`, value: null });
    }
  }
  for (const h of forecast.hospitals) {
    let open: { start: EpochMs; max: number } | null = null;
    for (const c of [...h.checkpoints, null]) {
      const on = c !== null && c.pSpike >= TIMELINE_SURGE_BAND_PSPIKE && c.tMs <= toMs;
      if (on && open === null) open = { start: c.tMs, max: c.pSpike };
      else if (on && open !== null) open.max = Math.max(open.max, c.pSpike);
      else if (!on && open !== null) {
        const end = c?.tMs ?? toMs;
        items.push({ kind: 'surge_band', tMs: open.start, endMs: end, hospitalId: h.hospitalId, physicianId: null, label: `${name(h.hospitalId)} surge risk`, detail: `P(spike) >= ${TIMELINE_SURGE_BAND_PSPIKE} from ${etClock(open.start)} to ${etClock(end)} ET (max ${open.max})`, value: open.max });
        open = null;
      }
    }
  }
  for (const hid of [...new Set(plan.cells.map((c) => c.hospitalId))].sort(compareIds)) {
    let open: { start: EpochMs; max: number; cls: string } | null = null;
    const cells = plan.cells.filter((c) => c.hospitalId === hid);
    for (const c of [...cells, null]) {
      const on = c !== null && c.pGap >= TIMELINE_GAP_BAND_PGAP && c.startMs <= toMs;
      if (on && open === null) open = { start: c.startMs, max: c.pGap, cls: c.existingClass };
      else if (on && open !== null) open.max = Math.max(open.max, c.pGap);
      else if (!on && open !== null) {
        const end = c?.startMs ?? Math.min(toMs, cells.at(-1)?.endMs ?? toMs);
        items.push({ kind: 'gap_band', tMs: open.start, endMs: end, hospitalId: hid, physicianId: null, label: `${name(hid)} gap risk`, detail: `P(gap) >= ${TIMELINE_GAP_BAND_PGAP} from ${etClock(open.start)} to ${etClock(end)} ET (max ${open.max}, class ${open.cls})`, value: open.max });
        open = null;
      }
    }
  }
  for (const o of foldOffers(log, nowMs)) {
    const st = statusOf(o, nowMs);
    if (st === 'delivered' && o.delivered !== null) items.push({ kind: 'offer_expiry', tMs: expiresAt(o.delivered.atMs), endMs: null, hospitalId: null, physicianId: o.proposal.physicianId, label: `offer to ${who(o.proposal.physicianId)} expires`, detail: `${etClock(expiresAt(o.delivered.atMs))} ET (brief: 10 minutes)`, value: null });
  }
  for (const s of foldStandbys(log, nowMs)) {
    const st = standbyStatus(s, nowMs);
    if (st === 'prealert_delivered' && s.prealertDelivered !== null) items.push({ kind: 'standby_expiry', tMs: s.prealertDelivered.expiresAtMs, endMs: null, hospitalId: null, physicianId: s.proposal.physicianId, label: `standby pre-alert to ${who(s.proposal.physicianId)} expires`, detail: `${etClock(s.prealertDelivered.expiresAtMs)} ET`, value: null });
    if (st === 'activation_delivered' && s.activation?.delivered) items.push({ kind: 'standby_expiry', tMs: s.activation.delivered.expiresAtMs, endMs: null, hospitalId: null, physicianId: s.proposal.physicianId, label: `activation request to ${who(s.proposal.physicianId)} expires`, detail: `${etClock(s.activation.delivered.expiresAtMs)} ET`, value: null });
  }
  // Action deadlines: propose by T or the relief cannot be online before the first covered gap.
  for (const sel of plan.selected) {
    const cand = plan.candidates.find((c) => c.physicianId === sel.physicianId);
    const firstGap = sel.coveredCells.filter((c) => c.pGap >= TIMELINE_GAP_BAND_PGAP).sort((a, b) => a.startMs - b.startMs)[0];
    if (cand === undefined || firstGap === undefined) continue;
    const deadline = firstGap.startMs - (STANDBY_APPROVAL_LATENCY_MIN + REWIND_LATENCY_MIN.ackMin + REWIND_LATENCY_MIN.activationApprovalMin + REWIND_LATENCY_MIN.acceptMin + cand.minutesToOnline) * MIN;
    items.push({ kind: 'action_deadline', tMs: deadline, endMs: null, hospitalId: firstGap.hospitalId, physicianId: sel.physicianId, label: `pre-alert ${who(sel.physicianId)} by ${etClock(deadline)}`, detail: `or ${who(sel.physicianId)} cannot be online before the ${etClock(firstGap.startMs)} gap at ${name(firstGap.hospitalId)} (approval ${STANDBY_APPROVAL_LATENCY_MIN} + ack ${REWIND_LATENCY_MIN.ackMin} + activation ${REWIND_LATENCY_MIN.activationApprovalMin + REWIND_LATENCY_MIN.acceptMin} + ${cand.minutesToOnline} min to come online)`, value: null });
  }
  const offer = decision.recommendedOffer;
  if (offer !== null) {
    const firstNeed = decision.needs.filter((n) => offer.coversNeeds.includes(n.id)).sort((a, b) => a.startMs - b.startMs)[0];
    if (firstNeed !== undefined) {
      const deadline = Math.max(firstNeed.startMs, nowMs) - (REWIND_LATENCY_MIN.leadApprovalMin + REWIND_LATENCY_MIN.acceptMin + offer.window.minutesToOnline) * MIN;
      items.push({ kind: 'action_deadline', tMs: deadline, endMs: null, hospitalId: firstNeed.hospitalId, physicianId: offer.physicianId, label: `propose offer to ${who(offer.physicianId)} by ${etClock(deadline)}`, detail: `or ${who(offer.physicianId)} cannot be online before ${etClock(Math.max(firstNeed.startMs, nowMs))} at ${name(firstNeed.hospitalId)} (${firstNeed.kind}); approval ${REWIND_LATENCY_MIN.leadApprovalMin} + accept ${REWIND_LATENCY_MIN.acceptMin} + ${offer.window.minutesToOnline} min to come online`, value: null });
    }
  }
  return { fromMs: nowMs, toMs, items: items.sort((a, b) => a.tMs - b.tMs || a.kind.localeCompare(b.kind) || (a.hospitalId ?? '').localeCompare(b.hospitalId ?? '') || (a.physicianId ?? '').localeCompare(b.physicianId ?? '')) };
}

// ---------------------------------------------------------------- next best action

const KIND_ORDER: readonly NbaKind[] = ['REASSIGN_CONSULT', 'ESCALATE_TO_CLINICAL_LEAD', 'STANDBY_PREALERT', 'SPLIT_SHIFT_OFFER', 'NOTE_HANDOFF_PLAN', 'VERIFY_PRESENCE'];

export function rankActions(input: IntelInput, incidents: readonly Incident[]): NextBestAction[] {
  const { decision, plan, nowMs, log } = input;
  const det = decision.detection;
  const name = (h: string) => det.staffing.hospitalNames.get(h) ?? h;
  const who = (p: string) => det.staffing.physicianNames.get(p) ?? p;
  const incidentsOf = (attentionIds: readonly string[]) => incidents.filter((i) => i.memberItemIds.some((m) => attentionIds.includes(m))).map((i) => i.id);
  const horizonEnd = decision.decisionCoverage.horizonEndMs;
  /** Minutes a consult at h waits for the first known relief if nothing is done: its DEADLOCK_NOW need's end, else the time to the next critical threshold. */
  const minutesAtRisk = (consultId: string, hospitalId: string): { minutes: number; why: string } => {
    const need = decision.needs.find((n) => n.kind === 'DEADLOCK_NOW' && n.hospitalId === hospitalId);
    if (need !== undefined) {
      const end = need.endMs === 'beyond_horizon' ? horizonEnd : need.endMs;
      return { minutes: Math.max(0, (end - nowMs) / MIN), why: `deadlock at ${name(hospitalId)} lasts until ${etClock(end)} ET without relief (OQ-32)` };
    }
    const s = det.standards.filter((x) => x.consultId === consultId).sort((a, b) => a.criticalAtMs - b.criticalAtMs)[0];
    if (s !== undefined) return { minutes: Math.max(NBA_DEFAULT_PROTECTED_MIN, (s.criticalAtMs - nowMs) / MIN), why: `${s.label}: critical at ${etClock(s.criticalAtMs)} ET` };
    return { minutes: NBA_DEFAULT_PROTECTED_MIN, why: `default ${NBA_DEFAULT_PROTECTED_MIN} protected minutes (LOOKAHEAD-DEFINED)` };
  };
  const strokeWeight = (consultIds: readonly string[]) => (consultIds.some((c) => det.state.consults[c]?.consultType === 'Stroke') ? 1 : NBA_GENERAL_NEURO_WEIGHT);
  const seen = new Set<string>();
  const drafts: Omit<NextBestAction, 'rank' | 'score' | 'id'>[] = [];
  const push = (d: Omit<NextBestAction, 'rank' | 'score' | 'id'>) => {
    const key = `${d.kind}|${[...d.consultIds].sort().join(',')}|${[...d.physicianIds].sort().join(',')}|${[...d.hospitalIds].sort().join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    drafts.push(d);
  };

  for (const i of decision.interventions) {
    const rights = DECISION_RIGHTS[i.kind];
    const base = { proposer: rights.proposer, approver: rights.approver, acceptor: rights.acceptor, hospitalIds: i.targets.hospitalIds, physicianIds: i.targets.physicianIds, consultIds: i.targets.consultIds, linkedIncidentIds: incidentsOf(i.linkedAttentionIds), linkedAttentionIds: i.linkedAttentionIds, proposeByMs: null };
    switch (i.kind) {
      case 'REASSIGN_CONSULT': {
        const top = i.candidates[0];
        const consultId = i.targets.consultIds[0] ?? '';
        if (top === undefined) break; // no routable candidate: escalation carries the risk
        const risk = minutesAtRisk(consultId, i.targets.hospitalIds[0] ?? '');
        const averted = risk.minutes * strokeWeight([consultId]) * NBA_SUCCESS_PROBABILITY.REASSIGN_CONSULT;
        push({ ...base, kind: 'REASSIGN_CONSULT', title: `Reassign ${consultId} to ${who(top.physicianId)}`, detail: i.expectedEffect, command: { type: 'requestReassignment', consultId, toPhysicianId: top.physicianId }, expectedStrokeMinutesAverted: r1(averted), coordinatorMinutes: NBA_COORDINATOR_MINUTES.REASSIGN_CONSULT, pSuccess: NBA_SUCCESS_PROBABILITY.REASSIGN_CONSULT, why: [risk.why, `${top.why}`] });
        break;
      }
      case 'ESCALATE_TO_CLINICAL_LEAD': {
        const consultId = i.targets.consultIds[0];
        const h = i.targets.hospitalIds[0] ?? '';
        const risk = consultId === undefined ? { minutes: NBA_DEFAULT_PROTECTED_MIN, why: `default ${NBA_DEFAULT_PROTECTED_MIN} protected minutes (LOOKAHEAD-DEFINED)` } : minutesAtRisk(consultId, h);
        const averted = risk.minutes * strokeWeight(i.targets.consultIds) * NBA_SUCCESS_PROBABILITY.ESCALATE_TO_CLINICAL_LEAD;
        const subject = { attentionItemId: i.linkedAttentionIds[0], consultIds: i.targets.consultIds, hospitalIds: i.targets.hospitalIds, needId: i.linkedNeedIds[0] };
        push({ ...base, kind: 'ESCALATE_TO_CLINICAL_LEAD', title: `Escalate: ${i.why[0]?.replace(/^Escalate: /, '') ?? name(h)}`, detail: i.expectedEffect, command: { type: 'raiseEscalation', subject, reason: i.why[0] ?? 'top issue needs the clinical lead' }, expectedStrokeMinutesAverted: r1(averted), coordinatorMinutes: NBA_COORDINATOR_MINUTES.ESCALATE_TO_CLINICAL_LEAD, pSuccess: NBA_SUCCESS_PROBABILITY.ESCALATE_TO_CLINICAL_LEAD, why: [risk.why, `escalation assumed to resolve the risk with probability ${NBA_SUCCESS_PROBABILITY.ESCALATE_TO_CLINICAL_LEAD} (LOOKAHEAD-DEFINED)`] });
        break;
      }
      case 'SPLIT_SHIFT_OFFER': {
        const o = decision.recommendedOffer;
        if (o === null) break;
        const entry = decision.ledger.find((e) => e.physicianId === o.physicianId);
        const pAccept = plan.candidates.find((c) => c.physicianId === o.physicianId)?.pAccept ?? 0.8;
        // Value: the offer's need-minutes (OQ-33 value is weighted need-minutes; use stroke-weighted minutes at the scope hospitals), times P(accept).
        const minutes = (entry?.valueTerms ?? []).reduce((s, t) => s + t.minutes * (strokeAt(det, t.hospitalId) ? 1 : NBA_GENERAL_NEURO_WEIGHT), 0);
        const inFlight = foldOffers(log, nowMs).some((x) => ['proposed', 'approved', 'sent', 'delivered'].includes(statusOf(x, nowMs)));
        if (inFlight) break;
        const firstNeed = decision.needs.filter((n) => o.coversNeeds.includes(n.id)).sort((a, b) => a.startMs - b.startMs)[0];
        push({ ...base, kind: 'SPLIT_SHIFT_OFFER', title: `Propose split-shift offer to ${o.name}`, detail: `${etClock(o.window.startMs)}-${etClock(o.window.endMs)} ET, scope ${o.routingScope.map(name).join(', ')}, seeded at ${o.seededConsultCount}`, command: { type: 'proposeOffer', physicianId: o.physicianId }, expectedStrokeMinutesAverted: r1(minutes * pAccept), coordinatorMinutes: NBA_COORDINATOR_MINUTES.SPLIT_SHIFT_OFFER, pSuccess: pAccept, why: [`${Math.round(minutes)} stroke-weighted need-minutes inside the window (OQ-33 value terms), times P(accept) ${pAccept} (illustrative)`, ...o.why.slice(0, 1)], proposeByMs: firstNeed === undefined ? null : Math.max(firstNeed.startMs, nowMs) - (REWIND_LATENCY_MIN.leadApprovalMin + REWIND_LATENCY_MIN.acceptMin + o.window.minutesToOnline) * MIN });
        break;
      }
      case 'NOTE_HANDOFF_PLAN': {
        const minutes = i.targets.consultIds.reduce((s, c) => s + minutesAtRisk(c, '').minutes, 0);
        const averted = minutes * strokeWeight(i.targets.consultIds) * NBA_SUCCESS_PROBABILITY.NOTE_HANDOFF_PLAN;
        push({ ...base, kind: 'NOTE_HANDOFF_PLAN', title: `Note handoff: ${who(i.targets.physicianIds[0] ?? '')}`, detail: i.expectedEffect, command: { type: 'sendInternalAlert', message: i.expectedEffect, physicianIds: i.targets.physicianIds }, expectedStrokeMinutesAverted: r1(averted), coordinatorMinutes: NBA_COORDINATOR_MINUTES.NOTE_HANDOFF_PLAN, pSuccess: NBA_SUCCESS_PROBABILITY.NOTE_HANDOFF_PLAN, why: [`${i.targets.consultIds.length} open note(s); minutes to each critical threshold summed`, ...i.why.slice(0, 1)] });
        break;
      }
      case 'VERIFY_PRESENCE': {
        const p = i.targets.physicianIds[0] ?? '';
        const strokes = (det.state.physicians[p]?.openConsultIds ?? []).filter((c) => det.state.consults[c]?.consultType === 'Stroke');
        const averted = NBA_DEFAULT_PROTECTED_MIN * (strokes.length > 0 ? 1 : NBA_GENERAL_NEURO_WEIGHT) * NBA_SUCCESS_PROBABILITY.VERIFY_PRESENCE * 0.5;
        push({ ...base, kind: 'VERIFY_PRESENCE', title: `Verify presence: ${who(p)}`, detail: i.expectedEffect, command: { type: 'sendInternalAlert', message: i.expectedEffect, physicianIds: [p] }, expectedStrokeMinutesAverted: r1(averted), coordinatorMinutes: NBA_COORDINATOR_MINUTES.VERIFY_PRESENCE, pSuccess: NBA_SUCCESS_PROBABILITY.VERIFY_PRESENCE, why: [`internal alert (automation allowed, brief); protects ${NBA_DEFAULT_PROTECTED_MIN} min at half weight (LOOKAHEAD-DEFINED)`, ...i.why.slice(0, 1)] });
        break;
      }
    }
  }
  // Standby pre-alerts for the plan's selected physicians (not yet pre-alerted tonight; no in-flight standby for them).
  const standbyBusy = new Set(foldStandbys(log, nowMs).filter((s) => !['declined', 'rejected', 'expired', 'cancelled', 'released', 'activation_declined'].includes(standbyStatus(s, nowMs))).map((s) => s.proposal.physicianId));
  for (const sel of plan.selected) {
    if (standbyBusy.has(sel.physicianId)) continue;
    const cand = plan.candidates.find((c) => c.physicianId === sel.physicianId);
    const firstGap = sel.coveredCells.filter((c) => c.pGap >= TIMELINE_GAP_BAND_PGAP).sort((a, b) => a.startMs - b.startMs)[0];
    const linked = incidents.filter((i) => i.hospitalIds.some((h) => sel.coveredHospitals.includes(h))).map((i) => i.id);
    push({
      kind: 'STANDBY_PREALERT',
      title: `Pre-alert standby: ${sel.name}`,
      detail: `${etClock(sel.window.startMs)}-${etClock(sel.window.endMs)} ET, covers ${sel.coveredHospitals.map(name).join(', ')}; expected ${sel.valueEUM} weighted uncovered minutes avoided`,
      proposer: DECISION_RIGHTS.SPLIT_SHIFT_OFFER.proposer,
      approver: DECISION_RIGHTS.SPLIT_SHIFT_OFFER.approver,
      acceptor: DECISION_RIGHTS.SPLIT_SHIFT_OFFER.acceptor,
      command: { type: 'proposeStandby', physicianId: sel.physicianId },
      expectedStrokeMinutesAverted: r1(sel.valueEUM),
      coordinatorMinutes: NBA_COORDINATOR_MINUTES.STANDBY_PREALERT,
      pSuccess: sel.pAccept,
      why: sel.why.slice(0, 2),
      hospitalIds: sel.coveredHospitals,
      physicianIds: [sel.physicianId],
      consultIds: [],
      linkedIncidentIds: linked,
      linkedAttentionIds: incidents.filter((i) => linked.includes(i.id)).flatMap((i) => i.memberItemIds),
      proposeByMs: firstGap === undefined || cand === undefined ? null : firstGap.startMs - (STANDBY_APPROVAL_LATENCY_MIN + REWIND_LATENCY_MIN.ackMin + REWIND_LATENCY_MIN.activationApprovalMin + REWIND_LATENCY_MIN.acceptMin + cand.minutesToOnline) * MIN,
    });
  }
  return drafts
    .map((d) => ({ ...d, score: r1(d.expectedStrokeMinutesAverted / d.coordinatorMinutes) }))
    .sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title))
    .map((d, i) => ({ ...d, id: `nba-${fnv1a(`${d.kind}|${d.title}|${d.consultIds.join(',')}|${d.physicianIds.join(',')}`)}`, rank: i + 1 }));
}

function strokeAt(det: DecisionReport['detection'], hospitalId: string): boolean {
  return Object.values(det.state.consults).some((c) => c.open && c.hospitalId === hospitalId && c.consultType === 'Stroke');
}

export type { Intervention };
