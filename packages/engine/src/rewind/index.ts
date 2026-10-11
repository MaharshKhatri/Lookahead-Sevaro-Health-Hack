import { ROUTING_RETRY_MS } from '../detect/brief-rules';
import { decide } from '../decide';
import { chooseRoute } from '../detect/routing';
import { etClock, offerShift, withShifts } from '../detect/staffing';
import { detect } from '../detect';
import { buildForecastModel } from '../forecast';
import { REWIND_EVAL_HORIZON_MIN, REWIND_LATENCY_MIN, REWIND_START_SECOND_OF_DAY_ET, REWIND_STEP_MIN, STANDBY_ACTIVATE_PGAP } from '../policy';
import { compareIds } from '../replay/derive';
import { dedupe } from '../replay/normalize';
import type { NetworkState } from '../replay/types';
import { buildStandbyPlan, type StandbyPlan, type StandbySelection } from '../standby';
import { activationTrigger } from '../act/standby';
import { etDateOf, etWallClockToEpoch } from '../time';
import type { Dataset, EpochMs } from '../types';
import type { StandbyProposal } from '../act/types';

/**
 * Rewind (Phase 5): simulate the past as if Lookahead had been running.
 * Origins every REWIND_STEP_MIN from REWIND_START (16:00 ET) to the dataset's
 * now; at each origin the forecast, the standby plan and the activation
 * trigger run on knowledge-time state only. The first pre-alert and
 * activation recommended for a hospital that later had routing failures or a
 * deadlock are turned into a counterfactual online time with the displayed
 * human latencies, and the actual routing_attempt_failed events after that
 * time are re-evaluated with the EXISTING routing model (rules 1-5, scoped
 * and seeded per OQ-35). Three lines are compared per stroke consult:
 * actual, reactive (the split-shift offer at now) and anticipatory (standby).
 * No LLM, no hard-coded ids; numbers are reported as they come out.
 */

export interface RewindOrigin {
  readonly tMs: EpochMs;
  readonly pSpikeByHospital: Readonly<Record<string, number>>;
  readonly pGapByHospital: Readonly<Record<string, number>>;
  readonly ruleTripped: boolean;
  readonly recommendedPreAlert: readonly string[];
  readonly activationRecommended: boolean;
  readonly deadlocks: readonly string[];
}

export interface RewindMarker {
  readonly kind: 'rule_tripped' | 'pre_alert' | 'activation' | 'online' | 'first_routing_failure' | 'deadlock';
  readonly tMs: EpochMs;
  readonly hospitalId?: string;
  readonly physicianId?: string;
  readonly detail: string;
}

export interface RewindConsultLine {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly receivedMs: EpochMs;
  readonly assignedMs: EpochMs | null;
  readonly minutesUnassigned: number;
  readonly assignedTo: string | null;
}

export interface RewindLine {
  readonly kind: 'actual' | 'reactive' | 'anticipatory';
  readonly label: string;
  readonly onlineAtMs: EpochMs | null;
  readonly physicianId: string | null;
  readonly totalStrokeMinutesUnassigned: number;
  readonly perConsult: readonly RewindConsultLine[];
}

export interface RewindFirstActions {
  readonly hospitalId: string;
  readonly physicianId: string;
  readonly preAlertAtMs: EpochMs;
  readonly ackAtMs: EpochMs;
  readonly activationRecommendedAtMs: EpochMs | null;
  readonly activationAcceptedAtMs: EpochMs | null;
  readonly onlineAtMs: EpochMs | null;
}

export interface RewindReport {
  readonly schemaVersion: '1.0';
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
  readonly stepMin: number;
  readonly evalHorizonMs: EpochMs;
  readonly assumptions: { readonly leadApprovalMin: number; readonly ackMin: number; readonly activationApprovalMin: number; readonly acceptMin: number; readonly note: string };
  readonly origins: readonly RewindOrigin[];
  readonly affectedHospitals: readonly string[];
  readonly firstActions: RewindFirstActions | null;
  readonly markers: readonly RewindMarker[];
  readonly engagedMedianMin: Readonly<Record<string, number>>;
  readonly lines: readonly RewindLine[];
  readonly explanation: readonly string[];
}

export interface RewindOptions {
  /** false: no standby network (the anticipatory line must then equal the actual line). */
  readonly standbyEnabled?: boolean;
  readonly fromMs?: EpochMs;
}

const MIN = 60_000;

export function rewind(dataset: Dataset, nowMs: EpochMs, opts: RewindOptions = {}): RewindReport {
  const standbyEnabled = opts.standbyEnabled ?? true;
  const fromMs = opts.fromMs ?? etWallClockToEpoch(etDateOf(nowMs), REWIND_START_SECOND_OF_DAY_ET);
  const evalHorizonMs = nowMs + REWIND_EVAL_HORIZON_MIN * MIN;
  const known = dedupe(dataset.events.filter((e) => e.ingestedAt <= nowMs)).events;
  const failures = known.filter((e) => e.eventType === 'routing_attempt_failed' && e.hospitalId !== null).sort((a, b) => a.eventTime - b.eventTime);
  const affected = [...new Set(failures.map((e) => e.hospitalId ?? ''))].sort(compareIds);
  const finalDecision = decide(dataset, nowMs);
  for (const n of finalDecision.needs) if (n.kind === 'DEADLOCK_NOW' && !affected.includes(n.hospitalId)) affected.push(n.hospitalId);
  affected.sort(compareIds);

  // 1. Origins: forecast + standby + triggers on knowledge-time state.
  const origins: RewindOrigin[] = [];
  const markers: RewindMarker[] = [];
  let first: RewindFirstActions | null = null;
  let ruleTrippedAt: EpochMs | null = null;
  let deadlockAt: EpochMs | null = null;
  let pending: { selection: StandbySelection; plan: StandbyPlan; proposal: StandbyProposal; preAlertAtMs: EpochMs; ackAtMs: EpochMs } | null = null;
  for (let t = fromMs; t <= nowMs; t += REWIND_STEP_MIN * MIN) {
    const d = decide(dataset, t);
    const model = buildForecastModel(dataset, d.detection.state, t);
    const plan = buildStandbyPlan({ dataset, decision: d, model, nowMs: t });
    const pSpike: Record<string, number> = {};
    const pGap: Record<string, number> = {};
    for (const h of dataset.hospitals) {
      pSpike[h.hospitalId] = model.hospitals.has(h.hospitalId) ? (plan.cells.find((c) => c.hospitalId === h.hospitalId)?.pSpike ?? 0) : 0;
      pGap[h.hospitalId] = plan.hospitals.find((x) => x.hospitalId === h.hospitalId)?.maxPGap ?? 0;
    }
    const deadlocks = d.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => n.hospitalId);
    const tripped = d.detection.demand.some((x) => x.spike);
    if (tripped && ruleTrippedAt === null) {
      ruleTrippedAt = t;
      const h = d.detection.demand.find((x) => x.spike);
      markers.push({ kind: 'rule_tripped', tMs: t, ...(h === undefined ? {} : { hospitalId: h.hospitalId }), detail: `demand spike rule first true at ${etClock(t)} ET (${h?.count ?? '?'} consults in 60 min vs p90 ${h?.p90 ?? '?'})` });
    }
    if (deadlocks.length > 0 && deadlockAt === null) {
      deadlockAt = t;
      markers.push({ kind: 'deadlock', tMs: t, ...(deadlocks[0] === undefined ? {} : { hospitalId: deadlocks[0] }), detail: `first routing deadlock seen at a ${REWIND_STEP_MIN}-min origin: ${deadlocks.join(', ')}` });
    }
    // First pre-alert recommended for an affected hospital.
    const relevant = plan.selected.find((s) => s.coveredHospitals.some((h) => affected.includes(h)));
    if (standbyEnabled && first === null && pending === null && relevant !== undefined) {
      const preAlertAtMs = t + REWIND_LATENCY_MIN.leadApprovalMin * MIN;
      const ackAtMs = preAlertAtMs + REWIND_LATENCY_MIN.ackMin * MIN;
      pending = { selection: relevant, plan, proposal: proposalOf(relevant, plan, t), preAlertAtMs, ackAtMs };
      markers.push({ kind: 'pre_alert', tMs: preAlertAtMs, physicianId: relevant.physicianId, hospitalId: relevant.coveredHospitals.find((h) => affected.includes(h)) ?? relevant.coveredHospitals[0] ?? '', detail: `standby pre-alert to ${relevant.physicianId} recommended at ${etClock(t)}, sent ${etClock(preAlertAtMs)} after lead approval (${REWIND_LATENCY_MIN.leadApprovalMin} min), acknowledged ${etClock(ackAtMs)} (${REWIND_LATENCY_MIN.ackMin} min)` });
    }
    let activation = false;
    if (standbyEnabled && pending !== null && first === null && t >= pending.ackAtMs) {
      const trig = activationTrigger(plan, pending.proposal, t, deadlocks);
      if (trig !== null) {
        activation = true;
        const accepted = t + (REWIND_LATENCY_MIN.activationApprovalMin + REWIND_LATENCY_MIN.acceptMin) * MIN;
        const online = Math.max(pending.proposal.window.startMs, accepted + pending.proposal.minutesToOnline * MIN);
        first = { hospitalId: trig.hospitalId ?? pending.proposal.coveredHospitalIds[0] ?? '', physicianId: pending.proposal.physicianId, preAlertAtMs: pending.preAlertAtMs, ackAtMs: pending.ackAtMs, activationRecommendedAtMs: t, activationAcceptedAtMs: accepted, onlineAtMs: online };
        markers.push({ kind: 'activation', tMs: t, physicianId: first.physicianId, ...(trig.hospitalId === null ? {} : { hospitalId: trig.hospitalId }), detail: `activation recommended at ${etClock(t)} (${trig.kind}: ${trig.detail}); approved + accepted by ${etClock(accepted)}` });
        markers.push({ kind: 'online', tMs: online, physicianId: first.physicianId, detail: `${first.physicianId} online at ${etClock(online)} ET (${pending.proposal.minutesToOnline} min to come online, OQ-39), scoped to ${pending.proposal.coveredHospitalIds.join(', ')}` });
      }
    }
    origins.push({ tMs: t, pSpikeByHospital: pSpike, pGapByHospital: pGap, ruleTripped: tripped, recommendedPreAlert: plan.selected.map((s) => s.physicianId), activationRecommended: activation, deadlocks });
  }
  if (first === null && pending !== null) {
    first = { hospitalId: pending.proposal.coveredHospitalIds[0] ?? '', physicianId: pending.proposal.physicianId, preAlertAtMs: pending.preAlertAtMs, ackAtMs: pending.ackAtMs, activationRecommendedAtMs: null, activationAcceptedAtMs: null, onlineAtMs: null };
  }
  const firstFailure = failures[0];
  if (firstFailure !== undefined) markers.push({ kind: 'first_routing_failure', tMs: firstFailure.eventTime, hospitalId: firstFailure.hospitalId ?? '', detail: `first routing_attempt_failed in the stream at ${etClock(firstFailure.eventTime)} ET (${firstFailure.consultId ?? '?'})` });
  markers.sort((a, b) => a.tMs - b.tMs);

  // 2. Lines.
  const state = finalDecision.detection.state;
  const engaged = engagedMedians(dataset, nowMs);
  const strokes = Object.values(state.consults)
    .filter((c) => c.consultType === 'Stroke' && c.receivedMs !== null && c.hospitalId !== null)
    .sort((a, b) => (a.receivedMs ?? 0) - (b.receivedMs ?? 0));
  const reliefByHospital = new Map<string, EpochMs>();
  for (const n of finalDecision.needs) if (n.kind === 'DEADLOCK_NOW') reliefByHospital.set(n.hospitalId, n.endMs === 'beyond_horizon' ? evalHorizonMs : n.endMs);
  const actual: RewindLine = line('actual', 'What actually happened (stream to its end; deadlocks persist until the first known relief, OQ-32)', null, null, strokes.map((c) => actualLine(c, reliefByHospital, evalHorizonMs)));

  // Reactive: the split-shift offer recommended at now, with the same latencies.
  const offer = finalDecision.recommendedOffer;
  let reactive: RewindLine;
  if (offer === null) reactive = line('reactive', 'Lookahead reactive: no split-shift offer recommended at now', null, null, actual.perConsult);
  else {
    const accepted = nowMs + (REWIND_LATENCY_MIN.leadApprovalMin + REWIND_LATENCY_MIN.acceptMin) * MIN;
    const online = Math.max(offer.window.startMs, accepted + offer.window.minutesToOnline * MIN);
    reactive = counterfactualLine(dataset, nowMs, 'reactive', `Lookahead reactive: split-shift offer to ${offer.physicianId} at ${etClock(nowMs)}, online ${etClock(online)}`, { physicianId: offer.physicianId, name: offer.name, startMs: online, endMs: offer.window.endMs, scopeHospitalIds: offer.routingScope, seededConsultCount: offer.seededConsultCount }, strokes, failures, engaged, reliefByHospital, evalHorizonMs, actual);
  }
  let anticipatory: RewindLine;
  if (!standbyEnabled || first === null || first.onlineAtMs === null || pending === null) {
    anticipatory = line('anticipatory', standbyEnabled ? 'Lookahead anticipatory: no activation was recommended before now' : 'Standby disabled', null, null, actual.perConsult);
  } else {
    const p = pending.proposal;
    const seed = anticipatorySeed(dataset, first.onlineAtMs, p);
    anticipatory = counterfactualLine(dataset, nowMs, 'anticipatory', `Lookahead anticipatory: standby ${first.physicianId} online ${etClock(first.onlineAtMs)}`, { physicianId: p.physicianId, name: p.name, startMs: first.onlineAtMs, endMs: p.window.endMs, scopeHospitalIds: p.coveredHospitalIds, seededConsultCount: seed }, strokes, failures, engaged, reliefByHospital, evalHorizonMs, actual);
  }
  const lines = [actual, reactive, anticipatory];
  const explanation = explain(lines, first, markers, engaged, nowMs);
  return {
    schemaVersion: '1.0',
    fromMs,
    toMs: nowMs,
    stepMin: REWIND_STEP_MIN,
    evalHorizonMs,
    assumptions: { ...REWIND_LATENCY_MIN, note: `Human latencies are LOOKAHEAD-DEFINED (illustrative); time to come online is the roster's est_minutes_to_online; engaged durations are the day's empirical medians by consult type; unassigned minutes are counted to ${etClock(evalHorizonMs)} ET.` },
    origins,
    affectedHospitals: affected,
    firstActions: first,
    markers,
    engagedMedianMin: engaged,
    lines,
    explanation,
  };
}

function line(kind: RewindLine['kind'], label: string, onlineAtMs: EpochMs | null, physicianId: string | null, perConsult: readonly RewindConsultLine[]): RewindLine {
  return { kind, label, onlineAtMs, physicianId, totalStrokeMinutesUnassigned: Math.round(perConsult.reduce((s, c) => s + c.minutesUnassigned, 0) * 10) / 10, perConsult };
}

function actualLine(c: NetworkState['consults'][string], relief: ReadonlyMap<string, EpochMs>, evalHorizonMs: EpochMs): RewindConsultLine {
  const received = c.receivedMs ?? 0;
  const assigned = c.assignmentHistory[0]?.atMs ?? null;
  const end = assigned ?? Math.min(evalHorizonMs, relief.get(c.hospitalId ?? '') ?? evalHorizonMs);
  return { consultId: c.consultId, hospitalId: c.hospitalId ?? '', receivedMs: received, assignedMs: assigned ?? (end < evalHorizonMs ? end : null), minutesUnassigned: Math.round(((end - received) / MIN) * 10) / 10, assignedTo: c.assignmentHistory[0]?.physicianId ?? (end < evalHorizonMs ? 'relief' : null) };
}

interface Relief {
  readonly physicianId: string;
  readonly name: string;
  readonly startMs: EpochMs;
  readonly endMs: EpochMs;
  readonly scopeHospitalIds: readonly string[];
  readonly seededConsultCount: number;
}

/**
 * Walk the actual routing failures (and their 5-minute retries, rule 5) after
 * the relief physician is online; re-evaluate each with the existing routing
 * model with the relief scoped and seeded; a selected physician is busy for
 * the empirical median engaged duration of that consult type.
 */
function counterfactualLine(
  dataset: Dataset,
  nowMs: EpochMs,
  kind: RewindLine['kind'],
  label: string,
  relief: Relief,
  strokes: readonly NetworkState['consults'][string][],
  failures: readonly Dataset['events'][number][],
  engaged: Readonly<Record<string, number>>,
  reliefByHospital: ReadonlyMap<string, EpochMs>,
  evalHorizonMs: EpochMs,
  actual: RewindLine,
): RewindLine {
  let busyUntil = 0;
  const assigned = new Map<string, EpochMs>();
  const unresolved = strokes.filter((c) => c.assignmentHistory.length === 0 && c.receivedMs !== null);
  const attempts: { consultId: string; hospitalId: string; tMs: EpochMs }[] = [];
  for (const c of unresolved) {
    const mine = failures.filter((f) => f.consultId === c.consultId);
    const last = mine.at(-1)?.eventTime ?? c.receivedMs ?? nowMs;
    for (const f of mine) attempts.push({ consultId: c.consultId, hospitalId: c.hospitalId ?? '', tMs: f.eventTime });
    for (let t = last + ROUTING_RETRY_MS; t <= evalHorizonMs; t += ROUTING_RETRY_MS) attempts.push({ consultId: c.consultId, hospitalId: c.hospitalId ?? '', tMs: t });
  }
  attempts.sort((a, b) => a.tMs - b.tMs || compareIds(a.consultId, b.consultId));
  for (const a of attempts) {
    if (assigned.has(a.consultId) || a.tMs < relief.startMs || a.tMs >= relief.endMs || a.tMs < busyUntil) continue;
    if (!relief.scopeHospitalIds.includes(a.hospitalId)) continue;
    const evalAt = Math.min(a.tMs, nowMs); // knowledge-time state cannot go past the stream's end
    const det = detect(dataset, evalAt);
    const shift = offerShift(det.state, relief);
    const staffing = withShifts(det.staffing, [{ ...shift, startMs: Math.min(shift.startMs, evalAt) }]);
    const choice = chooseRoute(det.state, staffing, a.hospitalId, evalAt, { forConsultId: a.consultId });
    if (choice.chosen === relief.physicianId) {
      assigned.set(a.consultId, a.tMs);
      const type = strokes.find((c) => c.consultId === a.consultId)?.consultType ?? 'Stroke';
      busyUntil = a.tMs + (engaged[type] ?? 0) * MIN;
    }
  }
  const perConsult = actual.perConsult.map((row) => {
    const cf = assigned.get(row.consultId);
    if (cf === undefined) return row;
    const actualEnd = row.assignedMs ?? evalHorizonMs;
    const end = Math.min(actualEnd, cf, reliefByHospital.get(row.hospitalId) ?? evalHorizonMs);
    return { ...row, assignedMs: end, minutesUnassigned: Math.round(((end - row.receivedMs) / MIN) * 10) / 10, assignedTo: end === cf ? relief.physicianId : row.assignedTo };
  });
  return line(kind, label, relief.startMs, relief.physicianId, perConsult);
}

/** Empirical median engaged minutes by consult type: physician_assigned -> last of video_ended / call_ended for that consult, from the day's stream known at now. */
export function engagedMedians(dataset: Dataset, nowMs: EpochMs): Record<string, number> {
  const known = dedupe(dataset.events.filter((e) => e.ingestedAt <= nowMs && e.eventTime <= nowMs)).events;
  const assignedAt = new Map<string, EpochMs>();
  const endAt = new Map<string, EpochMs>();
  const type = new Map<string, string>();
  for (const e of known) {
    if (e.consultId === null) continue;
    if (e.eventType === 'consult_received') type.set(e.consultId, e.description.endsWith(' consult request received') ? e.description.slice(0, -' consult request received'.length) : 'unknown');
    if (e.eventType === 'physician_assigned' && !assignedAt.has(e.consultId)) assignedAt.set(e.consultId, e.eventTime);
    if (e.eventType === 'video_ended' || e.eventType === 'incoming_call_ended' || e.eventType === 'outgoing_call_ended') endAt.set(e.consultId, Math.max(endAt.get(e.consultId) ?? 0, e.eventTime));
  }
  const byType = new Map<string, number[]>();
  for (const [id, a] of assignedAt) {
    const end = endAt.get(id);
    if (end === undefined || end <= a) continue;
    const k = type.get(id) ?? 'unknown';
    byType.set(k, [...(byType.get(k) ?? []), (end - a) / MIN]);
  }
  const out: Record<string, number> = {};
  for (const [k, xs] of byType) {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    out[k] = Math.round((s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2) * 10) / 10;
  }
  return out;
}

function proposalOf(s: StandbySelection, plan: StandbyPlan, tMs: EpochMs): StandbyProposal {
  const cand = plan.candidates.find((c) => c.physicianId === s.physicianId);
  return {
    standbyId: `rewind-${s.physicianId}`,
    physicianId: s.physicianId,
    name: s.name,
    channel: 'simulated',
    decisionAtMs: tMs,
    minutesToOnline: cand?.minutesToOnline ?? 0,
    window: { startMs: s.window.startMs, endMs: s.window.endMs, minutes: s.window.minutes },
    coveredHospitalIds: s.coveredHospitals,
    hospitalNames: s.coveredHospitals.map((h) => plan.hospitals.find((x) => x.hospitalId === h)?.hospitalName ?? h),
    coveredCells: s.coveredCells,
    pAccept: s.pAccept,
    valueEUM: s.valueEUM,
    falseAlarmChance: s.falseAlarmChance,
    candidates: [],
    planWhy: s.why,
    message: '',
  };
}

/** SEED at the counterfactual online time: median consults of on-shift peers at the scope hospitals (OQ-35), via the existing trap analysis inputs. */
function anticipatorySeed(dataset: Dataset, onlineMs: EpochMs, p: StandbyProposal): number {
  const d = detect(dataset, Math.min(onlineMs, Math.max(...dataset.events.map((e) => e.ingestedAt))));
  const peers = d.staffing.shifts.filter((s) => s.physicianId !== p.physicianId && s.startMs <= onlineMs && onlineMs < s.endMs && p.coveredHospitalIds.some((h) => d.staffing.credentials.get(s.physicianId)?.has(h)));
  const counts = peers.map((s) => d.state.physicians[s.physicianId]?.consultsThisShift ?? 0).sort((a, b) => a - b);
  if (counts.length === 0) return 0;
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 === 1 ? (counts[mid] ?? 0) : Math.floor(((counts[mid - 1] ?? 0) + (counts[mid] ?? 0)) / 2);
}

function explain(lines: readonly RewindLine[], first: RewindFirstActions | null, markers: readonly RewindMarker[], engaged: Readonly<Record<string, number>>, nowMs: EpochMs): string[] {
  const [actual, reactive, anticipatory] = lines;
  const out: string[] = [];
  if (actual) out.push(`Actual: ${actual.totalStrokeMinutesUnassigned} stroke consult-minutes unassigned across ${actual.perConsult.length} stroke consults (counted to the evaluation horizon).`);
  if (reactive) out.push(`Reactive: ${reactive.totalStrokeMinutesUnassigned} (${reactive.label}).`);
  if (anticipatory) out.push(`Anticipatory: ${anticipatory.totalStrokeMinutesUnassigned} (${anticipatory.label}).`);
  if (first === null) out.push('No standby pre-alert was recommended for an affected hospital before now, so anticipation could not help on this stream.');
  else if (first.onlineAtMs === null) out.push(`A pre-alert to ${first.physicianId} was recommended (sent ${etClock(first.preAlertAtMs)} ET) but no activation trigger fired before ${etClock(nowMs)} ET, so the physician was never asked to log on.`);
  if (actual && anticipatory && anticipatory.totalStrokeMinutesUnassigned >= actual.totalStrokeMinutesUnassigned && first?.onlineAtMs !== null && first !== null) {
    out.push(`Anticipation did not reduce unassigned stroke minutes here: the standby came online at ${etClock(first.onlineAtMs)} ET, after the window in which it could have taken the stranded consults, or the routing model did not select them (scope, seed, busy).`);
  }
  const rule = markers.find((m) => m.kind === 'rule_tripped');
  const pre = markers.find((m) => m.kind === 'pre_alert');
  if (rule && pre) out.push(`Lead time: pre-alert sent ${Math.round((rule.tMs - pre.tMs) / MIN)} min ${pre.tMs <= rule.tMs ? 'before' : 'after'} the deterministic spike rule first tripped (${etClock(rule.tMs)} ET).`);
  out.push(`Engaged-duration medians used for busy time: ${Object.entries(engaged).map(([k, v]) => `${k} ${v} min`).join(', ') || 'none measured'}.`);
  return out;
}

export { REWIND_LATENCY_MIN, STANDBY_ACTIVATE_PGAP as REWIND_ACTIVATE_PGAP };
