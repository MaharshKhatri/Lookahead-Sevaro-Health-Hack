import { compareIds } from '../replay/derive';
import { dedupe } from '../replay/normalize';
import type { Dataset, EpochMs } from '../types';
import type { RewindConsultLine, RewindLine, RewindReport } from './index';

/**
 * Opener (final polish sprint, A1). LOOKAHEAD-DEFINED: the brief has no
 * "opening episode"; this picks the single most impactful stroke episode
 * from an EXISTING rewind report (never recomputed with different logic) so
 * the demo can open on one concrete counterfactual. Brief (Challenge 2,
 * "Why it matters"): stroke consults are the time-critical ones; the rewind
 * compares stroke consult-minutes unassigned on three lines.
 *
 * Score per stroke consult = (actual - anticipatory minutes) x (1 + number of
 * routing_attempt_failed events for that consult known by report.toMs), so a
 * consult that visibly failed routing (brief, routing rule 5: retry every
 * 5 min) and would have been taken earlier ranks first. Ties break by consult
 * id. When anticipation helps nobody, the biggest reactive win is reported
 * instead (kind 'reactive_only'); when neither helps, null.
 */

export interface OpenerSummary {
  readonly kind: 'anticipatory' | 'reactive_only';
  readonly consultId: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  /** The relief physician's routing scope, as names (standby scope from the rewind's online marker; the consult's hospital when not available). */
  readonly coveredHospitalNames: readonly string[];
  /** The physician of the line that produced the win (standby for 'anticipatory', split-shift offer for 'reactive_only'). */
  readonly standbyPhysicianId: string;
  readonly standbyPhysicianDisplayName: string;
  /** Standby pre-alert sent (rewind firstActions); null for 'reactive_only' (no pre-alert exists on the reactive line). */
  readonly preAlertTimeMs: EpochMs | null;
  /** Activation recommended (anticipatory) or the reactive offer decision instant (report.toMs). */
  readonly activationTimeMs: EpochMs | null;
  /** Counterfactual online time of the line that produced the win. */
  readonly onlineTimeMs: EpochMs | null;
  /** The consult's receipt: the unassigned clock starts here (rewind actual line). */
  readonly actualGapOpenedMs: EpochMs;
  /** First routing_attempt_failed for the consult known by report.toMs, if any. */
  readonly firstRoutingFailureMs: EpochMs | null;
  /** End of the actual unassigned interval (assignment, relief, or the evaluation horizon). */
  readonly actualGapEndMs: EpochMs;
  /** True when the consult was still unassigned at the evaluation horizon (the actual wait is a lower bound). */
  readonly actualStillUnassigned: boolean;
  /** End of the counterfactual wait on the line that produced the win. */
  readonly wouldHaveAssignedMs: EpochMs;
  readonly evalHorizonMs: EpochMs;
  readonly actualWaitMin: number;
  readonly reactiveWaitMin: number;
  readonly anticipatoryWaitMin: number;
  readonly strokeMinutesAverted: number;
  readonly routingFailures: number;
  readonly score: number;
  /** Exactly report.assumptions (REWIND_LATENCY_MIN plus the note). */
  readonly assumptions: RewindReport['assumptions'];
}

const MIN = 60_000;
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** "Dr. <LastName>" from the roster name (on-shift, off-shift, credentialing rows); the id when no name is listed. */
export function physicianDisplayName(dataset: Dataset, physicianId: string): string {
  const name = [...dataset.offShiftRoster, ...dataset.physiciansOnShift, ...dataset.credentials].find((p) => p.physicianId === physicianId)?.name.trim() ?? '';
  const parts = name.replace(/^Dr\.?\s+/i, '').split(/\s+/).filter((p) => p !== '');
  const last = parts.at(-1);
  return last === undefined ? physicianId : `Dr. ${last}`;
}

interface Candidate {
  readonly actual: RewindConsultLine;
  readonly reactive: RewindConsultLine;
  readonly anticipatory: RewindConsultLine;
  readonly win: RewindConsultLine;
  readonly averted: number;
  readonly failures: number;
  readonly score: number;
}

function best(actual: RewindLine, reactive: RewindLine, anticipatory: RewindLine, which: 'reactive' | 'anticipatory', failuresByConsult: ReadonlyMap<string, number>): Candidate | null {
  let top: Candidate | null = null;
  actual.perConsult.forEach((a, i) => {
    const r = reactive.perConsult[i];
    const p = anticipatory.perConsult[i];
    if (r === undefined || p === undefined || r.consultId !== a.consultId || p.consultId !== a.consultId) return;
    const win = which === 'anticipatory' ? p : r;
    const averted = round1(a.minutesUnassigned - win.minutesUnassigned);
    if (averted <= 0) return;
    const failures = failuresByConsult.get(a.consultId) ?? 0;
    const score = round1(averted * (1 + failures));
    if (top === null || score > top.score || (score === top.score && compareIds(a.consultId, top.actual.consultId) < 0)) top = { actual: a, reactive: r, anticipatory: p, win, averted, failures, score };
  });
  return top;
}

/** Standby scope from the rewind's online marker ("..., scoped to H1, H2"), kept only where the id is a hospital of the dataset. */
function standbyScope(report: RewindReport, dataset: Dataset, physicianId: string): string[] {
  const online = report.markers.find((m) => m.kind === 'online' && m.physicianId === physicianId);
  const scoped = online === undefined ? null : /scoped to (.+)$/.exec(online.detail);
  if (scoped === null || scoped[1] === undefined) return [];
  const known = new Set(dataset.hospitals.map((h) => h.hospitalId));
  return scoped[1].split(',').map((s) => s.trim()).filter((h) => known.has(h));
}

export function openerSummary(report: RewindReport, dataset: Dataset): OpenerSummary | null {
  const actual = report.lines.find((l) => l.kind === 'actual');
  const reactive = report.lines.find((l) => l.kind === 'reactive');
  const anticipatory = report.lines.find((l) => l.kind === 'anticipatory');
  if (actual === undefined || reactive === undefined || anticipatory === undefined) return null;

  // Brief, routing rule 5: failed attempts are logged as routing_attempt_failed; counted on knowledge time (ingested by report.toMs).
  const known = dedupe(dataset.events.filter((e) => e.ingestedAt <= report.toMs)).events;
  const failuresByConsult = new Map<string, number>();
  const firstFailure = new Map<string, EpochMs>();
  for (const e of known) {
    if (e.eventType !== 'routing_attempt_failed' || e.consultId === null) continue;
    failuresByConsult.set(e.consultId, (failuresByConsult.get(e.consultId) ?? 0) + 1);
    firstFailure.set(e.consultId, Math.min(firstFailure.get(e.consultId) ?? e.eventTime, e.eventTime));
  }

  const ant = best(actual, reactive, anticipatory, 'anticipatory', failuresByConsult);
  const pick = ant ?? best(actual, reactive, anticipatory, 'reactive', failuresByConsult);
  if (pick === null) return null;
  const kind: OpenerSummary['kind'] = ant === null ? 'reactive_only' : 'anticipatory';
  const line = kind === 'anticipatory' ? anticipatory : reactive;
  const first = report.firstActions;
  const physicianId = line.physicianId ?? (kind === 'anticipatory' ? (first?.physicianId ?? '') : '');
  const names = new Map(dataset.hospitals.map((h) => [h.hospitalId, h.hospitalName]));
  const nameOf = (h: string): string => names.get(h) ?? h;
  const scope = kind === 'anticipatory' ? standbyScope(report, dataset, physicianId) : [];
  const a = pick.actual;
  const actualEnd = a.assignedMs ?? a.receivedMs + a.minutesUnassigned * MIN;
  return {
    kind,
    consultId: a.consultId,
    hospitalId: a.hospitalId,
    hospitalName: nameOf(a.hospitalId),
    coveredHospitalNames: (scope.length > 0 ? scope : [a.hospitalId]).map(nameOf),
    standbyPhysicianId: physicianId,
    standbyPhysicianDisplayName: physicianId === '' ? '' : physicianDisplayName(dataset, physicianId),
    preAlertTimeMs: kind === 'anticipatory' ? (first?.preAlertAtMs ?? null) : null,
    activationTimeMs: kind === 'anticipatory' ? (first?.activationRecommendedAtMs ?? null) : report.toMs,
    onlineTimeMs: line.onlineAtMs,
    actualGapOpenedMs: a.receivedMs,
    firstRoutingFailureMs: firstFailure.get(a.consultId) ?? null,
    actualGapEndMs: actualEnd,
    actualStillUnassigned: a.assignedMs === null,
    wouldHaveAssignedMs: pick.win.assignedMs ?? pick.win.receivedMs + pick.win.minutesUnassigned * MIN,
    evalHorizonMs: report.evalHorizonMs,
    actualWaitMin: a.minutesUnassigned,
    reactiveWaitMin: pick.reactive.minutesUnassigned,
    anticipatoryWaitMin: pick.anticipatory.minutesUnassigned,
    strokeMinutesAverted: pick.averted,
    routingFailures: pick.failures,
    score: pick.score,
    assumptions: report.assumptions,
  };
}
