import { ATTENTION_SEVERITY_BANDS, ATTENTION_WEIGHTS, IMMINENT_WINDOW_MIN } from '../policy';
import { compareIds } from '../replay/derive';
import type { EventRef, NetworkState, PhysicianFlag } from '../replay/types';
import type { EpochMs } from '../types';
import type { StandardCode } from './brief-rules';
import type { CoverageGap, CoverageProjection } from './coverage';
import type { DemandEvaluation } from './demand';
import { blockingExclusions, dedupeRefs, type DeadlockFinding } from './routing';
import { etClock, etClockS, minutes, type StaffingModel } from './staffing';
import type { OpenNotesEvaluation, StandardEvaluation } from './standards';

/**
 * Brief "What Teams Must Demonstrate" #3: "Detect and rank what needs
 * attention, and explain why each item was flagged." Scores are a sum of named
 * factors from policy.ATTENTION_WEIGHTS; headlines are templates with no
 * patient information (consult ids, hospital and physician names only).
 */

export type AttentionKind = keyof typeof ATTENTION_WEIGHTS.kind;
export type Severity = (typeof ATTENTION_SEVERITY_BANDS)[number]['severity'];

export interface AttentionItem {
  readonly id: string;
  readonly kind: AttentionKind;
  readonly severity: Severity;
  readonly strokeAtRisk: boolean;
  readonly hospitalIds: readonly string[];
  readonly consultIds: readonly string[];
  readonly physicianIds: readonly string[];
  readonly timeToImpactMs: number;
  readonly score: number;
  readonly scoreBreakdown: readonly { readonly factor: string; readonly points: number }[];
  readonly headline: string;
  readonly why: readonly string[];
  readonly because: readonly EventRef[];
}

export interface AttentionInputs {
  readonly state: NetworkState;
  readonly staffing: StaffingModel;
  readonly nowMs: EpochMs;
  readonly horizonMin: number;
  readonly standards: readonly StandardEvaluation[];
  readonly openNotes: readonly OpenNotesEvaluation[];
  readonly demand: readonly DemandEvaluation[];
  readonly coverage: CoverageProjection;
  readonly deadlocks: readonly DeadlockFinding[];
}

const W = ATTENTION_WEIGHTS;
const IMMINENT_MS = IMMINENT_WINDOW_MIN * 60_000;
const SHORT_STANDARD: Record<StandardCode, string> = {
  TRIAGED_NOT_ASSIGNED: 'triaged, not assigned',
  ASSIGNED_NOT_CONTACTED: 'assigned, not contacted',
  IMAGING_PENDING: 'imaging pending',
  IMAGING_REVIEW: 'imaging review',
  NOTE_COMPLETION: 'note open',
};

interface Draft {
  kind: AttentionKind;
  key: string;
  strokeAtRisk: boolean;
  hospitalIds: string[];
  consultIds: string[];
  physicianIds: string[];
  timeToImpactMs: number;
  factors: { factor: string; points: number }[];
  headline: string;
  why: string[];
  because: readonly EventRef[];
}

/** Builds and ranks the attention list: score desc, then id asc (deterministic). */
export function buildAttention(input: AttentionInputs): AttentionItem[] {
  const drafts = [
    ...input.deadlocks.map((d) => deadlockItem(input, d)),
    ...input.standards.flatMap((s) => standardItem(input, s)),
    ...input.coverage.gaps.map((g) => gapItem(input, g)),
    ...input.demand.filter((d) => d.spike).map((d) => spikeItem(input, d)),
    ...input.openNotes.filter((n) => n.level !== 'ok').map((n) => openNotesItem(input, n)),
    ...Object.values(input.state.physicians).flatMap((p) => p.flags.flatMap((f) => signalItem(input, p.physicianId, f))),
  ];
  return drafts.map(finish).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function finish(d: Draft): AttentionItem {
  const factors = d.factors.filter((f) => f.points !== 0).map((f) => ({ factor: f.factor, points: round1(f.points) }));
  const score = round1(factors.reduce((a, f) => a + f.points, 0));
  const severity = ATTENTION_SEVERITY_BANDS.find((b) => score >= b.minScore)?.severity ?? 'low';
  return {
    id: `att-${fnv1a(`${d.kind}|${d.key}`)}`,
    kind: d.kind,
    severity,
    strokeAtRisk: d.strokeAtRisk,
    hospitalIds: d.hospitalIds,
    consultIds: d.consultIds,
    physicianIds: d.physicianIds,
    timeToImpactMs: d.timeToImpactMs,
    score,
    scoreBreakdown: factors,
    headline: clip(d.headline, 90),
    why: d.why,
    because: dedupeRefs(d.because),
  };
}

// ---------- shared factor helpers ----------

const base = (kind: AttentionKind) => ({ factor: `kind:${kind}`, points: W.kind[kind] });
const stroke = (atRisk: boolean) => ({ factor: 'stroke_at_risk', points: atRisk ? W.strokeAtRisk : 0 });
const level = (l: 'warning' | 'critical') => ({ factor: `level:${l}`, points: W.level[l] });
function urgency(input: AttentionInputs, ttiMs: number) {
  const frac = Math.max(0, 1 - ttiMs / (input.horizonMin * 60_000));
  return { factor: 'urgency', points: W.urgencyMax * frac };
}

const hospitalName = (input: AttentionInputs, id: string | null) => (id === null ? 'unknown hospital' : (input.staffing.hospitalNames.get(id) ?? id));
const physicianLabel = (input: AttentionInputs, id: string) => `${input.staffing.physicianNames.get(id) ?? id} (${id})`;
const openStrokeAt = (input: AttentionInputs, hospitalId: string) =>
  Object.values(input.state.consults).some((c) => c.open && c.hospitalId === hospitalId && c.consultType === 'Stroke');

// ---------- item builders ----------

function deadlockItem(input: AttentionInputs, d: DeadlockFinding): Draft {
  const isStroke = d.consultType === 'Stroke';
  const failures = d.routingFailures.length;
  const waited = d.receivedMs === null ? null : input.nowMs - d.receivedMs;
  const why = [
    `Routing rule 5: nobody is eligible at ${hospitalName(input, d.hospitalId)} right now; ${failures} routing_attempt_failed event(s)${failures > 0 ? `, first at ${etClockS(d.routingFailures[0]?.atMs ?? 0)} ET` : ''}.`,
    `${d.consultId} (${d.consultType ?? 'type unknown'}) is ${d.stage ?? 'in an unknown stage'}, unassigned${waited === null ? '' : `, ${minutes(waited)} min since received`}.`,
    ...blockingExclusions(d.choice).map((x) => `${physicianLabel(input, x.physicianId)} excluded: ${x.failedRules.map((r) => r.detail).join('; ')}.`),
    `Routable-now count for this consult: 0 (OQ-24(b)).`,
  ];
  return {
    kind: 'ROUTING_DEADLOCK',
    key: d.consultId,
    strokeAtRisk: isStroke,
    hospitalIds: [d.hospitalId],
    consultIds: [d.consultId],
    physicianIds: [],
    timeToImpactMs: 0,
    factors: [base('ROUTING_DEADLOCK'), level('critical'), stroke(isStroke), urgency(input, 0)],
    headline: `${d.consultId} ${d.consultType ?? ''} at ${hospitalName(input, d.hospitalId)}: no routable physician`.replace(/\s+/g, ' '),
    why,
    because: d.because,
  };
}

function standardItem(input: AttentionInputs, s: StandardEvaluation): Draft[] {
  const isStroke = s.consultType === 'Stroke';
  const c = input.state.consults[s.consultId];
  const assigned = c?.assignedPhysicianId ?? null;
  const thresholds = `warning ${minutes(s.warnAtMs - s.clockStartMs)} min, critical ${minutes(s.criticalAtMs - s.clockStartMs)} min`;
  const ruleLine = `Brief Operational Standards, "${s.label}" (${s.consultType ?? 'type unknown'}): ${thresholds}; reached when elapsed >= limit (OQ-05).`;
  const clockLine =
    s.standard === 'NOTE_COMPLETION'
      ? `Note clock started ${etClockS(s.clockStartMs)} ET at end of video or call (OQ-18); elapsed ${minutes(s.elapsedMs)} min.`
      : `Clock started ${etClockS(s.clockStartMs)} ET on entering the stage; elapsed ${minutes(s.elapsedMs)} min.`;
  const who = assigned === null ? 'Unassigned.' : `Assigned to ${physicianLabel(input, assigned)}, currently ${input.state.physicians[assigned]?.derivedState.value ?? 'unknown'}.`;
  const entities = { hospitalIds: s.hospitalId === null ? [] : [s.hospitalId], consultIds: [s.consultId], physicianIds: assigned === null ? [] : [assigned] };
  const label = `${s.consultId} ${s.consultType ?? ''}`.trim();

  if (s.level !== 'ok') {
    const crossedAt = s.level === 'critical' ? s.criticalAtMs : s.warnAtMs;
    const overdueMin = (input.nowMs - crossedAt) / 60_000;
    const escalates = s.level === 'warning' && s.criticalAtMs - input.nowMs <= IMMINENT_MS;
    const why = [ruleLine, clockLine, `${s.level === 'critical' ? 'Critical' : 'Warning'} since ${etClockS(crossedAt)} ET (${minutes(input.nowMs - crossedAt)} min ago).`, who];
    if (escalates) why.push(`Turns critical at ${etClockS(s.criticalAtMs)} ET (in ${minutes(s.criticalAtMs - input.nowMs)} min).`);
    return [
      {
        kind: 'STANDARD_BREACH',
        key: `${s.consultId}|${s.standard}`,
        strokeAtRisk: isStroke,
        ...entities,
        timeToImpactMs: 0,
        factors: [
          base('STANDARD_BREACH'),
          level(s.level),
          stroke(isStroke),
          urgency(input, 0),
          { factor: 'overdue', points: Math.min(W.overdueCap, W.overduePerMinute * overdueMin) },
          { factor: 'escalates_to_critical_soon', points: escalates ? W.escalatesSoon : 0 },
        ],
        headline: `${label}: ${SHORT_STANDARD[s.standard]} ${s.level.toUpperCase()}, ${minutes(s.elapsedMs)} min at ${hospitalName(input, s.hospitalId)}`,
        why,
        because: s.because,
      },
    ];
  }
  const tti = s.warnAtMs - input.nowMs;
  if (tti > IMMINENT_MS) return [];
  return [
    {
      kind: 'IMMINENT_BREACH',
      key: `${s.consultId}|${s.standard}`,
      strokeAtRisk: isStroke,
      ...entities,
      timeToImpactMs: tti,
      factors: [base('IMMINENT_BREACH'), level('warning'), stroke(isStroke), urgency(input, tti)],
      headline: `${label}: ${SHORT_STANDARD[s.standard]} warning in ${minutes(tti)} min (${etClock(s.warnAtMs)}) at ${hospitalName(input, s.hospitalId)}`,
      why: [ruleLine, clockLine, `Reaches warning at ${etClockS(s.warnAtMs)} ET, within the ${IMMINENT_WINDOW_MIN}-min imminent window.`, who],
      because: s.because,
    },
  ];
}

function gapItem(input: AttentionInputs, g: CoverageGap): Draft {
  const tti = Math.max(0, g.startMs - input.nowMs);
  const atRisk = openStrokeAt(input, g.hospitalId);
  const point = input.coverage.timeline.find((p) => p.tMs === g.startMs)?.perHospital[g.hospitalId];
  const until = g.endMs === 'beyond_horizon' ? `beyond the ${input.horizonMin}-min horizon` : `until ${etClock(g.endMs)} ET`;
  const why = [
    `Coverage: ${g.hospitalName} requires ${g.required} available credentialed physicians (block minimum ${point?.blockMinimum ?? '?'}${point?.spikeAdd ? ' + 1 for the demand spike' : ''}); staffed ${g.staffed} from ${etClock(g.startMs)} ET, ${until} (OQ-02, OQ-24(a)).`,
    `Still counted: ${g.whoRemains.length === 0 ? 'nobody' : g.whoRemains.map((id) => physicianLabel(input, id)).join(', ')}.`,
    ...g.causes.map((c) => `Cause: ${c.detail}.`),
  ];
  const earlier = input.coverage.gapsExcludingArrivals.find((x) => x.hospitalId === g.hospitalId && x.startMs < g.startMs);
  if (earlier !== undefined) {
    const arrivals = point?.scheduledArrivalIds ?? [];
    why.push(
      `Without scheduled arrivals the gap would start at ${etClock(earlier.startMs)} ET; scheduled shift(s) ${arrivals.length > 0 ? `of ${arrivals.join(', ')} ` : ''}hold coverage until ${etClock(g.startMs)} ET (OQ-27).`,
    );
  }
  return {
    kind: 'COVERAGE_GAP',
    key: `${g.hospitalId}|${g.startMs}`,
    strokeAtRisk: atRisk,
    hospitalIds: [g.hospitalId],
    consultIds: [],
    physicianIds: [...g.whoRemains],
    timeToImpactMs: tti,
    factors: [base('COVERAGE_GAP'), stroke(atRisk), urgency(input, tti), { factor: 'shortfall', points: W.shortfallPerPhysician * g.shortfall }],
    headline: `${g.hospitalName}: ${g.staffed} of ${g.required} required physicians from ${etClock(g.startMs)}`,
    why,
    because: g.causes.flatMap((c) => c.because),
  };
}

function spikeItem(input: AttentionInputs, d: DemandEvaluation): Draft {
  const strokeIds = d.contributingConsultIds.filter((id) => input.state.consults[id]?.consultType === 'Stroke');
  const excess = d.count - (d.p90 ?? 0);
  return {
    kind: 'DEMAND_SPIKE',
    key: d.hospitalId,
    strokeAtRisk: strokeIds.length > 0,
    hospitalIds: [d.hospitalId],
    consultIds: [...d.contributingConsultIds],
    physicianIds: [],
    timeToImpactMs: 0,
    factors: [
      base('DEMAND_SPIKE'),
      stroke(strokeIds.length > 0),
      urgency(input, 0),
      { factor: 'excess_over_p90', points: Math.min(W.spikeExcessCap, W.spikeExcessPerConsult * excess) },
    ],
    headline: `${d.hospitalName}: ${d.count} consults in the last 60 min (p90 ${d.p90 ?? '?'})`,
    why: [
      `Coverage: a demand spike is trailing 60-minute consults above the hospital's p90 for that hour; ${d.count} > p90 ${d.p90} for the ${d.baselineHourEt} ET baseline hour (mean ${d.mean}) (OQ-03, OQ-19).`,
      `Contributing consults: ${d.contributingConsultIds.map((id) => `${id} (${input.state.consults[id]?.consultType ?? '?'})`).join(', ')}.`,
      `Raises this hospital's coverage requirement by one for the projection horizon (OQ-19).`,
    ],
    because: d.because,
  };
}

function openNotesItem(input: AttentionInputs, n: OpenNotesEvaluation): Draft {
  const strokeNotes = n.noteConsultIds.filter((id) => input.state.consults[id]?.consultType === 'Stroke');
  const tti = Math.max(0, n.shiftEndMs - input.nowMs);
  const lvl = n.level === 'critical' ? 'critical' : 'warning';
  return {
    kind: 'OPEN_NOTES_NEAR_SHIFT_END',
    key: n.physicianId,
    strokeAtRisk: strokeNotes.length > 0,
    hospitalIds: [...new Set(n.noteConsultIds.map((id) => input.state.consults[id]?.hospitalId).filter((h): h is string => typeof h === 'string'))].sort(compareIds),
    consultIds: [...n.noteConsultIds],
    physicianIds: [n.physicianId],
    timeToImpactMs: tti,
    factors: [base('OPEN_NOTES_NEAR_SHIFT_END'), level(lvl), stroke(strokeNotes.length > 0), urgency(input, tti), { factor: 'open_notes', points: W.openNotePerNote * n.count }],
    headline: `${physicianLabel(input, n.physicianId)}: ${n.count} open note(s), shift ends ${etClock(n.shiftEndMs)}`,
    why: [
      `Brief Operational Standards, "Open notes within 60 min of the physician's shift end": any = warning, 2 or more = critical (OQ-22).`,
      `Shift ends ${etClock(n.shiftEndMs)} ET (in ${minutes(tti)} min); window opened ${etClock(n.windowEntersAtMs)} ET.`,
      `Open notes: ${n.noteConsultIds.map((id) => `${id} (${input.state.consults[id]?.consultType ?? '?'}, ${input.state.consults[id]?.stage ?? '?'})`).join(', ')}.`,
    ],
    because: n.because,
  };
}

function signalItem(input: AttentionInputs, physicianId: string, f: PhysicianFlag): Draft[] {
  const v = f.value;
  if (v.code === 'IN_MEETING_INTERRUPTIBLE') return [];
  const p = input.state.physicians[physicianId];
  const who = physicianLabel(input, physicianId);
  const strokeConsults = (p?.openConsultIds ?? []).filter((id) => input.state.consults[id]?.consultType === 'Stroke');
  let headline: string;
  let detail: string;
  let consultIds: string[] = [];
  let atRisk = false;
  switch (v.code) {
    case 'EXTERNAL_VIDEO_SUSPECTED':
      headline = `${who}: camera on with no Synapse session since ${etClock(v.sinceMs)}`;
      detail = `Availability: "Camera active with no Synapse video session and status not In Meeting: probably on an external video platform. Treat as busy and flag it." Camera active since ${etClockS(v.sinceMs)} ET.`;
      break;
    case 'AGENT_OFFLINE_UNVERIFIED':
      headline = `${who}: looks available but presence agent offline since ${etClock(v.sinceMs)}`;
      detail = `Availability: "Agent offline: routing assumes the physician is available, but this is unverified. Surface the risk." Offline since ${etClockS(v.sinceMs)} ET; derived state ${p?.derivedState.value ?? '?'}.`;
      break;
    case 'TEMP_UNAVAILABLE_WITH_ASSIGNED':
      consultIds = [...v.consultIds];
      atRisk = v.consultIds.some((id) => input.state.consults[id]?.consultType === 'Stroke');
      headline = `${who}: Temporarily Unavailable with ${v.consultIds.join(', ')} still assigned`;
      detail = `Self-reported Temporarily Unavailable since ${etClockS(v.sinceMs)} ET; still assigned: ${v.consultIds.map((id) => `${id} (${input.state.consults[id]?.consultType ?? '?'}, ${input.state.consults[id]?.stage ?? '?'})`).join(', ')}.`;
      break;
    case 'RINGING_UNANSWERED':
      consultIds = v.consultId === null ? [] : [v.consultId];
      atRisk = v.consultId !== null && input.state.consults[v.consultId]?.consultType === 'Stroke';
      headline = `${who}: call for ${v.consultId ?? '?'} ringing unanswered ${v.seconds} s`;
      detail = `Routing rule 2: a ringing phone blocks other calls (OQ-17); ringing since ${etClockS(v.sinceMs)} ET (${v.seconds} s).${p?.agent.online === false ? ' Presence agent is offline, so availability is unverified.' : ''}`;
      break;
  }
  const why = [detail];
  if (strokeConsults.length > 0 && v.code !== 'TEMP_UNAVAILABLE_WITH_ASSIGNED') why.push(`Open stroke consults with this physician: ${strokeConsults.join(', ')}.`);
  return [
    {
      kind: 'SIGNAL_CONFLICT',
      key: `${physicianId}|${v.code}`,
      strokeAtRisk: atRisk,
      hospitalIds: [...new Set(consultIds.map((id) => input.state.consults[id]?.hospitalId).filter((h): h is string => typeof h === 'string'))],
      consultIds,
      physicianIds: [physicianId],
      timeToImpactMs: 0,
      factors: [base('SIGNAL_CONFLICT'), { factor: `signal:${v.code}`, points: W.signal[v.code] }, stroke(atRisk), urgency(input, 0)],
      headline,
      why,
      because: f.because,
    },
  ];
}

// ---------- utils ----------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** FNV-1a 32-bit, hex: deterministic ids from kind + entities. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
