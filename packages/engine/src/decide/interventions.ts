import type { AttentionItem, DetectionReport } from '../detect';
import { blockingExclusions, chooseRoute, dedupeRefs } from '../detect/routing';
import { etClock } from '../detect/staffing';
import { INTERVENTION_TOP_ITEMS } from '../policy';
import type { EventRef } from '../replay/types';
import { fnv1a } from '../util/hash';
import { DECISION_RIGHTS, type InterventionKind } from './brief-rules';
import type { Intervention, Need, RecommendedOffer, TopIssueRecommendation } from './types';
import type { NeedChange, WhatIf } from './whatif';

/**
 * Intervention catalog: brief "Problem to Solve" layer 2 (Decide: "Reassign a
 * consult; escalate to clinical leadership; offer a split shift") with
 * decision rights from "Users and Decision Rights". Automation is allowed only
 * for internal coordinator alerts.
 */

export interface InterventionContext {
  readonly detection: DetectionReport;
  readonly needs: readonly Need[];
  readonly recommendedOffer: RecommendedOffer | null;
  readonly whatIf: WhatIf | null;
  readonly changes: readonly NeedChange[];
}

interface Draft {
  kind: InterventionKind;
  consultIds: string[];
  physicianIds: string[];
  hospitalIds: string[];
  candidates: Intervention['candidates'];
  expectedEffect: string;
  why: string[];
  because: readonly EventRef[];
  linkedAttentionIds: string[];
  linkedNeedIds: string[];
}

const KIND_ORDER: readonly InterventionKind[] = ['REASSIGN_CONSULT', 'ESCALATE_TO_CLINICAL_LEAD', 'SPLIT_SHIFT_OFFER', 'NOTE_HANDOFF_PLAN', 'VERIFY_PRESENCE'];

/** Interventions for the top attention items and every need, merged when they target the same thing. */
export function buildInterventions(ctx: InterventionContext): Intervention[] {
  const raw: Draft[] = [
    ...ctx.detection.attention.slice(0, INTERVENTION_TOP_ITEMS).flatMap((a) => forAttention(ctx, a)),
    ...ctx.needs.flatMap((n) => forNeed(ctx, n)),
  ];
  const drafts = [...raw.filter((d) => d.kind !== 'NOTE_HANDOFF_PLAN'), ...mergeNoteHandoffs(ctx, raw.filter((d) => d.kind === 'NOTE_HANDOFF_PLAN'))];
  const merged = new Map<string, Draft>();
  for (const d of drafts) {
    const key = `${d.kind}|${[...d.consultIds].sort().join(',')}|${[...d.physicianIds].sort().join(',')}|${[...d.hospitalIds].sort().join(',')}`;
    const prev = merged.get(key);
    if (prev === undefined) merged.set(key, { ...d });
    else {
      prev.linkedAttentionIds = [...new Set([...prev.linkedAttentionIds, ...d.linkedAttentionIds])];
      prev.linkedNeedIds = [...new Set([...prev.linkedNeedIds, ...d.linkedNeedIds])];
      prev.why = [...new Set([...prev.why, ...d.why])];
      prev.because = dedupeRefs([...prev.because, ...d.because]);
    }
  }
  return [...merged].map(([key, d]) => finish(key, d));
}

/** One handoff plan per physician covering all their open-note consults. */
function mergeNoteHandoffs(ctx: InterventionContext, drafts: readonly Draft[]): Draft[] {
  const byPhysician = new Map<string, Draft[]>();
  for (const d of drafts) for (const p of d.physicianIds) byPhysician.set(p, [...(byPhysician.get(p) ?? []), d]);
  return [...byPhysician].flatMap(([physicianId, ds]) =>
    noteHandoff(ctx, physicianId, [...new Set(ds.flatMap((d) => d.consultIds))].sort(), {
      linkedAttentionIds: [...new Set(ds.flatMap((d) => d.linkedAttentionIds))],
      linkedNeedIds: [...new Set(ds.flatMap((d) => d.linkedNeedIds))],
    }),
  );
}

function finish(key: string, d: Draft): Intervention {
  const rights = DECISION_RIGHTS[d.kind];
  return {
    id: `int-${fnv1a(key)}`,
    kind: d.kind,
    targets: { consultIds: d.consultIds, physicianIds: d.physicianIds, hospitalIds: d.hospitalIds },
    proposer: rights.proposer,
    approver: rights.approver,
    acceptor: rights.acceptor,
    automationAllowed: rights.automationAllowed,
    candidates: d.candidates,
    expectedEffect: d.expectedEffect,
    why: d.why,
    because: dedupeRefs(d.because),
    linkedAttentionIds: d.linkedAttentionIds,
    linkedNeedIds: d.linkedNeedIds,
  };
}

function forAttention(ctx: InterventionContext, a: AttentionItem): Draft[] {
  const link = { linkedAttentionIds: [a.id], linkedNeedIds: [] as string[] };
  const hospital = a.hospitalIds[0];
  const consult = a.consultIds[0];
  switch (a.kind) {
    case 'ROUTING_DEADLOCK':
      return [...reassign(ctx, consult ?? '', link), escalate(a, link), ...offer(ctx, hospital, link)];
    case 'STANDARD_BREACH':
    case 'IMMINENT_BREACH': {
      const s = ctx.detection.standards.find((x) => x.consultId === consult);
      if (s === undefined) return [escalate(a, link)];
      if (s.standard === 'NOTE_COMPLETION') return noteHandoff(ctx, ctx.detection.state.consults[s.consultId]?.assignedPhysicianId ?? null, [s.consultId], link);
      if (s.standard === 'IMAGING_PENDING') return [escalate(a, link)];
      const unassigned = ctx.detection.state.consults[s.consultId]?.assignedPhysicianId === null;
      return [...reassign(ctx, s.consultId, link), escalate(a, link), ...(unassigned ? offer(ctx, hospital, link) : [])];
    }
    case 'COVERAGE_GAP':
    case 'DEMAND_SPIKE':
      return [escalate(a, link), ...offer(ctx, hospital, link)];
    case 'OPEN_NOTES_NEAR_SHIFT_END':
      return noteHandoff(ctx, a.physicianIds[0] ?? null, a.consultIds, link);
    case 'SIGNAL_CONFLICT': {
      const physician = a.physicianIds[0] ?? '';
      const flag = ctx.detection.state.physicians[physician]?.flags.find((f) => a.headline.includes(physician) && f.value.code !== 'IN_MEETING_INTERRUPTIBLE' && signalMatches(a, f.value.code));
      if (flag?.value.code === 'TEMP_UNAVAILABLE_WITH_ASSIGNED') return [...a.consultIds.flatMap((c) => reassign(ctx, c, link)), escalate(a, link)];
      return [verifyPresence(physician, a.why[0] ?? a.headline, a.because, link)];
    }
  }
}

function signalMatches(a: AttentionItem, code: string): boolean {
  const map: Record<string, RegExp> = {
    EXTERNAL_VIDEO_SUSPECTED: /camera on/,
    AGENT_OFFLINE_UNVERIFIED: /agent offline/,
    TEMP_UNAVAILABLE_WITH_ASSIGNED: /Temporarily Unavailable/,
    RINGING_UNANSWERED: /ringing unanswered/,
  };
  return map[code]?.test(a.headline) ?? false;
}

function forNeed(ctx: InterventionContext, n: Need): Draft[] {
  const link = { linkedAttentionIds: [...n.attentionItemIds], linkedNeedIds: [n.id] };
  if (n.kind === 'AT_RISK') {
    // OQ-29/OQ-30: AT_RISK is advisory; the action is an internal presence check on each expected arrival.
    return expectedArrivals(ctx, n).map((p) =>
      verifyPresence(p, `${n.hospitalName} coverage from ${etClock(n.startMs)} ET depends on ${p}'s scheduled shift; no shift_started known yet (OQ-29).`, n.because, link),
    );
  }
  const subject = { id: n.id, headline: `${n.kind} at ${n.hospitalName} from ${etClock(n.startMs)} ET`, why: n.why, because: n.because, hospitalIds: [n.hospitalId], consultIds: [...n.consultIds] };
  return [escalateSubject(subject, link), ...offer(ctx, n.hospitalId, link)];
}

function expectedArrivals(ctx: InterventionContext, n: Need): string[] {
  const point = ctx.detection.coverage.timeline.find((p) => p.tMs === n.startMs)?.perHospital[n.hospitalId];
  if (point !== undefined) return [...point.expectedIds];
  return ctx.detection.staffing.shifts.filter((s) => s.confirmation === 'expected' && s.startMs <= n.startMs && n.startMs < s.endMs).map((s) => s.physicianId);
}

// ---------- intervention builders ----------

function reassign(ctx: InterventionContext, consultId: string, link: Pick<Draft, 'linkedAttentionIds' | 'linkedNeedIds'>): Draft[] {
  const { state, staffing, nowMs } = ctx.detection;
  const c = state.consults[consultId];
  if (c === undefined || c.hospitalId === null) return [];
  const choice = chooseRoute(state, staffing, c.hospitalId, nowMs, { forConsultId: consultId });
  const candidates = choice.ranked.filter((r) => r.physicianId !== c.assignedPhysicianId);
  const verb = c.assignedPhysicianId === null ? 'Assign' : 'Reassign';
  const label = `${consultId} (${c.consultType ?? '?'}, ${c.stage ?? '?'}) at ${staffing.hospitalNames.get(c.hospitalId) ?? c.hospitalId}`;
  const top = candidates[0];
  if (top !== undefined) {
    return [
      {
        kind: 'REASSIGN_CONSULT',
        consultIds: [consultId],
        physicianIds: [top.physicianId],
        hospitalIds: [c.hospitalId],
        candidates,
        expectedEffect: `${verb} to ${staffing.physicianNames.get(top.physicianId) ?? top.physicianId} (${top.physicianId}): ${top.why}.`,
        why: [`${verb} ${label}: ${candidates.length} routable candidate(s) under routing rules 1-4.`],
        because: [],
        ...link,
      },
    ];
  }
  const blocked = blockingExclusions(choice);
  const assigneeRoutable = c.assignedPhysicianId !== null && choice.ranked.some((r) => r.physicianId === c.assignedPhysicianId);
  return [
    {
      kind: 'REASSIGN_CONSULT',
      consultIds: [consultId],
      physicianIds: c.assignedPhysicianId === null ? [] : [c.assignedPhysicianId],
      hospitalIds: [c.hospitalId],
      candidates: [],
      expectedEffect: 'No routable candidate: fall through to escalation.',
      why: [
        `${verb} ${label}: no routable candidate (routing rule 5).`,
        ...blocked.map((x) => `${x.physicianId}: ${x.failedRules.map((r) => r.detail).join('; ')}.`),
        ...(assigneeRoutable ? [`${c.assignedPhysicianId}: current assignee, not a reassignment target.`] : []),
      ],
      because: blocked.flatMap((x) => x.failedRules.flatMap((r) => r.because)),
      ...link,
    },
  ];
}

function escalate(a: AttentionItem, link: Pick<Draft, 'linkedAttentionIds' | 'linkedNeedIds'>): Draft {
  return escalateSubject({ id: a.id, headline: a.headline, why: a.why, because: a.because, hospitalIds: [...a.hospitalIds], consultIds: [...a.consultIds] }, link);
}

function escalateSubject(
  subject: { id: string; headline: string; why: readonly string[]; because: readonly EventRef[]; hospitalIds: string[]; consultIds: string[] },
  link: Pick<Draft, 'linkedAttentionIds' | 'linkedNeedIds'>,
): Draft {
  return {
    kind: 'ESCALATE_TO_CLINICAL_LEAD',
    consultIds: subject.consultIds,
    physicianIds: [],
    hospitalIds: subject.hospitalIds,
    candidates: [],
    expectedEffect: 'Clinical lead reviews and may authorize an escalation (e.g. a physician-to-physician handoff) or approve a split-shift offer.',
    why: [`Escalate: ${subject.headline}.`, ...subject.why.slice(0, 2)],
    because: subject.because,
    ...link,
  };
}

function offer(ctx: InterventionContext, hospitalId: string | undefined, link: Pick<Draft, 'linkedAttentionIds' | 'linkedNeedIds'>): Draft[] {
  const o = ctx.recommendedOffer;
  if (o === null || hospitalId === undefined || !o.routingScope.includes(hospitalId)) return [];
  return [
    {
      kind: 'SPLIT_SHIFT_OFFER',
      consultIds: [],
      physicianIds: [o.physicianId],
      hospitalIds: [...o.routingScope],
      candidates: [],
      expectedEffect: offerEffect(ctx, o),
      why: [...o.why],
      because: [],
      ...link,
    },
  ];
}

function offerEffect(ctx: InterventionContext, o: RecommendedOffer): string {
  const routable = (ctx.whatIf?.routableAtOfferStart ?? []).map((r) => `${r.hospitalId} ${r.count}`).join(', ');
  const changed = ctx.changes
    .filter((c) => c.outcome !== 'unchanged')
    .map((c) => `${c.before.kind} ${c.before.hospitalId} ${etClock(c.before.startMs)} ${c.outcome}${c.outcome === 'closed' ? '' : ` (${c.detail})`}`);
  return `From ${etClock(o.window.startMs)} ET: routable count at scope hospitals ${routable || 'n/a'} (unverified until online). Needs: ${changed.join('; ') || 'no change'}.`;
}

function noteHandoff(ctx: InterventionContext, physicianId: string | null, consultIds: readonly string[], link: Pick<Draft, 'linkedAttentionIds' | 'linkedNeedIds'>): Draft[] {
  if (physicianId === null) return [];
  const p = ctx.detection.state.physicians[physicianId];
  const end = p?.shift?.endMs;
  return [
    {
      kind: 'NOTE_HANDOFF_PLAN',
      consultIds: [...consultIds],
      physicianIds: [physicianId],
      hospitalIds: [...new Set(consultIds.map((id) => ctx.detection.state.consults[id]?.hospitalId).filter((h): h is string => typeof h === 'string'))],
      candidates: [],
      expectedEffect: `Coordinator contacts ${p?.name ?? physicianId} to finish or hand off ${consultIds.join(', ')}${end === undefined ? '' : ` before shift end ${etClock(end)} ET`}.`,
      why: [`Open notes: ${consultIds.join(', ')} with ${physicianId} (brief Operational Standards, OQ-18/OQ-22).`],
      because: [],
      ...link,
    },
  ];
}

function verifyPresence(physicianId: string, reason: string, because: readonly EventRef[], link: Pick<Draft, 'linkedAttentionIds' | 'linkedNeedIds'>): Draft {
  return {
    kind: 'VERIFY_PRESENCE',
    consultIds: [],
    physicianIds: [physicianId],
    hospitalIds: [],
    candidates: [],
    expectedEffect: `Internal alert to the coordinator to verify ${physicianId}'s presence; no message to the physician.`,
    why: [reason],
    because,
    ...link,
  };
}

/** The action bundle for the #1 attention item, with rationale (brief "What Teams Must Demonstrate" #5). */
export function recommendForTopIssue(ctx: InterventionContext, interventions: readonly Intervention[]): TopIssueRecommendation | null {
  const top = ctx.detection.attention[0];
  if (top === undefined) return null;
  const actions = interventions
    .filter((i) => i.linkedAttentionIds.includes(top.id))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const reassign = actions.find((a) => a.kind === 'REASSIGN_CONSULT');
  const offerAction = actions.find((a) => a.kind === 'SPLIT_SHIFT_OFFER');
  const o = ctx.recommendedOffer;
  const rationale = [
    top.why[0] ?? top.headline,
    reassign === undefined ? 'Reassignment not applicable.' : reassign.candidates.length > 0 ? `Reassign: ${reassign.expectedEffect}` : `Reassign: no routable candidate (${reassign.why.slice(1).join(' ')})`,
    'Escalate to the clinical lead on duty, who authorizes escalations and approves split-shift offers.',
    offerAction === undefined || o === null
      ? 'No split-shift offer covers this hospital.'
      : `Split-shift offer to ${o.name} (${o.physicianId}), ${etClock(o.window.startMs)}-${etClock(o.window.endMs)} ET, scope ${o.routingScope.join(', ')}, seeded at ${o.seededConsultCount} consults: ${offerAction.expectedEffect}`,
  ];
  return { attentionItemId: top.id, headline: top.headline, actions, rationale };
}
