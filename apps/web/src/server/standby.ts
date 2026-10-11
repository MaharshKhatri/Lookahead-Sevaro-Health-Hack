import 'server-only';
import {
  STANDBY_MESSAGE_VOCABULARY,
  acceptedOffersOf,
  activationTrigger,
  assertNoPHI,
  foldStandbys,
  planWithLog,
  quietAt,
  standbyAllowedActions,
  standbyStatus,
  type ActContext,
  type ActionLog,
  type ActivationTrigger,
  type DecisionReport,
  type StandbyPlan,
  type StandbyRecord,
} from '@lookahead/engine';
import type { PublicStandbyDTO, StandbyDTO, StandbyPlanDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import { standbyPath } from './auth';
import { who } from './offers';
import type { StoreSnapshot } from './store';

/**
 * Standby network read models (Phase 7). Everything is folded from the action
 * log and the engine's plan (planWithLog, D-90); nothing here changes state
 * or re-evaluates a rule. The activation and stand-down recommendations reuse
 * the plan the view already computed (activationTrigger / quietAt are the
 * engine functions behind activationRecommended / standDownRecommended), so
 * the view costs one decide + one plan; the hysteresis step (quiet 5 min
 * earlier, OQ-51) recomputes only when the present is already quiet.
 */

const RECOMPUTE_MS = 5 * 60_000;

export function standbyPlanDTO(plan: StandbyPlan): StandbyPlanDTO {
  const starts = [...new Set(plan.cells.map((c) => c.startMs))].sort((a, b) => a - b);
  return {
    schemaVersion: plan.schemaVersion,
    asOfMs: plan.asOfMs,
    horizonEndMs: plan.horizonEndMs,
    cellStarts: starts,
    hospitals: plan.hospitals.map((h) => ({
      ...h,
      cells: plan.cells.filter((c) => c.hospitalId === h.hospitalId).map((c) => ({ startMs: c.startMs, pGap: c.pGap, pSpike: c.pSpike, existingClass: c.existingClass, supply: c.supply, requiredBase: c.requiredBase, coverableByOne: c.coverableByOne })),
    })),
    candidates: plan.candidates,
    selected: plan.selected,
    totals: { totalEUM: plan.totalEUM, totalWeightedEUM: plan.totalWeightedEUM, expectedEUMAvoided: plan.expectedEUMAvoided, residualEUM: plan.residualEUM, falseAlarmChance: plan.falseAlarmChance },
    emptyBenchHospitals: plan.emptyBenchHospitals,
    why: plan.why,
  };
}

/** P(gap) per (hospital, cell start) for the coverage grid's cells. */
export function pGapIndex(plan: StandbyPlan): ReadonlyMap<string, number> {
  return new Map(plan.cells.map((c) => [`${c.hospitalId}|${c.startMs}`, c.pGap]));
}

export function standbyDTOs(ctx: ActContext, s: StoreSnapshot, plan: StandbyPlan, decision: DecisionReport): StandbyDTO[] {
  const nowMs = s.clock.nowMs;
  const deadlocked = decision.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => n.hospitalId);
  return foldStandbys(s.log, nowMs).map((r) => {
    const status = standbyStatus(r, nowMs);
    const p = r.proposal;
    const trigger = status === 'acknowledged' ? activationTrigger(plan, p, nowMs, deadlocked) : null;
    const sd = status === 'acknowledged' ? standDown(ctx, s.log, plan, r, nowMs) : { recommended: false, quietNow: false, quietBefore: false };
    const allowed = standbyAllowedActions(status, trigger !== null, sd.recommended);
    const a = r.activation;
    const prealertExpiresAtMs = r.prealertDelivered?.expiresAtMs ?? null;
    const activation: StandbyDTO['activation'] =
      a === null
        ? null
        : {
            status: a.activated !== null ? 'activated' : a.declined !== null ? 'declined' : a.expired !== null ? 'expired' : a.rejected !== null ? 'rejected' : a.delivered !== null ? 'delivered' : a.sent !== null ? 'sent' : a.approved !== null ? 'approved' : 'proposed',
            trigger: a.proposed.payload.trigger,
            logOnByMs: a.proposed.payload.logOnByMs,
            endMs: a.proposed.payload.endMs,
            scopeHospitalIds: a.proposed.payload.scopeHospitalIds,
            seededConsultCount: a.proposed.payload.seededConsultCount,
            trapWhy: a.proposed.payload.trapWhy,
            message: a.proposed.payload.message,
            proposedAtMs: a.proposed.atMs,
            expiresAtMs: a.delivered?.expiresAtMs ?? null,
            msUntilExpiry: status === 'activation_delivered' && a.delivered !== null ? a.delivered.expiresAtMs - nowMs : null,
            effectiveStartMs: a.activated?.payload.effectiveStartMs ?? null,
            coverageEffect: a.activated?.payload.coverageEffect ?? null,
            rejectedReason: a.rejected?.reason ?? null,
          };
    return {
      standbyId: r.standbyId,
      physicianId: p.physicianId,
      name: p.name,
      status,
      channel: p.channel,
      window: p.window,
      minutesToOnline: p.minutesToOnline,
      coveredHospitalIds: p.coveredHospitalIds,
      hospitalNames: p.hospitalNames,
      pAccept: p.pAccept,
      valueEUM: p.valueEUM,
      falseAlarmChance: p.falseAlarmChance,
      message: r.prealertSent?.message ?? p.message,
      planWhy: p.planWhy,
      candidates: p.candidates,
      proposedAtMs: r.proposed.atMs,
      proposedBy: who(r.proposed.by) ?? '',
      approvedAtMs: r.approved?.atMs ?? null,
      approvedBy: who(r.approved?.by),
      acknowledgedAtMs: r.acknowledged?.atMs ?? null,
      prealertExpiresAtMs,
      msUntilExpiry: status === 'prealert_delivered' && prealertExpiresAtMs !== null ? prealertExpiresAtMs - nowMs : null,
      activation,
      activationRecommended: trigger,
      standDownRecommended: sd.recommended,
      quietNow: sd.quietNow,
      outcome: outcomeOf(r, status),
      allowedActions: allowed,
      standbyPath: standbyPath(r.standbyId),
    };
  });
}

function standDown(ctx: ActContext, log: ActionLog, plan: StandbyPlan, r: StandbyRecord, nowMs: number): { recommended: boolean; quietNow: boolean; quietBefore: boolean } {
  const quietNow = quietAt(plan, r.proposal, nowMs);
  if (!quietNow) return { recommended: false, quietNow, quietBefore: false };
  const before = nowMs - RECOMPUTE_MS;
  const quietBefore = before > r.proposed.atMs ? quietAt(planWithLog(ctx, log, before).plan, r.proposal, before) : false;
  return { recommended: quietNow && quietBefore, quietNow, quietBefore };
}

function outcomeOf(r: StandbyRecord, status: string): StandbyDTO['outcome'] {
  if (r.cancelled !== null) return { status: 'cancelled', atMs: r.cancelled.atMs, by: who(r.cancelled.by), detail: r.cancelled.reason };
  if (r.released !== null) return { status: 'released', atMs: r.released.atMs, by: who(r.released.by), detail: `${r.released.reason} · "${r.released.message}"` };
  if (r.rejected !== null) return { status: 'rejected', atMs: r.rejected.atMs, by: who(r.rejected.by), detail: r.rejected.reason };
  if (r.declined !== null) return { status: 'declined', atMs: r.declined.atMs, by: who(r.declined.by), detail: 'the physician answered "Not tonight"' };
  if (r.prealertExpired !== null) return { status: 'expired', atMs: r.prealertExpired.expiredAtMs, by: null, detail: `pre-alert not answered within 10 minutes (expired ${etHm(r.prealertExpired.expiredAtMs)} ET)` };
  if (status === 'expired') return { status: 'expired', atMs: r.prealertDelivered?.expiresAtMs ?? null, by: null, detail: 'pre-alert expired (derived; materialized at the next clock tick)' };
  const a = r.activation?.activated;
  if (a !== undefined && a !== null) return { status: 'activated', atMs: a.atMs, by: who(a.by), detail: `online from ${etHm(a.payload.effectiveStartMs)} until ${etHm(a.payload.endMs)} ET` };
  return null;
}

/** Live standbys for the activated-standby staffing check (what-if / grid): which standby physicians are counted as accepted offers. */
export const activatedIds = (log: ActionLog, nowMs: number): readonly string[] => acceptedOffersOf(log, nowMs).map((o) => o.physicianId);

// ------------------------------------------------------------------ physician phone view

/**
 * GET /api/standby/:id?t=: the off-shift physician's phone (brief "No patient
 * information in any notification. Hospital names, hours and start time
 * only."). Only the delivered pre-alert / activation texts and a plain state;
 * every string passes the engine's PHI guard before it leaves.
 */
export function publicStandby(s: StoreSnapshot, standbyId: string): PublicStandbyDTO | null {
  const nowMs = s.clock.nowMs;
  const r = foldStandbys(s.log, nowMs).find((x) => x.standbyId === standbyId);
  if (r === undefined) return null;
  const status = standbyStatus(r, nowMs);
  const p = r.proposal;
  const prealertDelivered = r.prealertDelivered !== null && r.prealertSent !== null;
  const a = r.activation;
  const activationDelivered = a !== null && a.delivered !== null && a.sent !== null;
  const prealertLines = prealertDelivered ? (r.prealertSent?.message ?? '').split('\n') : null;
  const activationLines = activationDelivered ? (a?.sent?.message ?? '').split('\n') : null;
  const releaseLines = r.released === null ? null : r.released.message.split('\n');
  const guard = (text: string) => assertNoPHI(text, { allowedWords: STANDBY_MESSAGE_VOCABULARY, allowedPhrases: p.hospitalNames });
  for (const lines of [prealertLines, activationLines, releaseLines]) if (lines !== null) guard(lines.join('\n'));
  const { headline, reason } = plainState(status, r);
  for (const text of [headline, reason ?? '']) assertNoPHI(text);
  const respond: PublicStandbyDTO['respond'] = status === 'prealert_delivered' ? 'standby' : status === 'activation_delivered' ? 'activation' : null;
  const expiresAtMs = status === 'prealert_delivered' ? (r.prealertDelivered?.expiresAtMs ?? null) : status === 'activation_delivered' ? (a?.delivered?.expiresAtMs ?? null) : null;
  return {
    standbyId,
    physicianId: p.physicianId,
    status,
    nowMs,
    clockMode: s.clock.mode,
    clockSpeed: s.clock.speed,
    hospitals: prealertDelivered ? p.hospitalNames : [],
    startMs: p.window.startMs,
    endMs: p.window.endMs,
    minutesToOnline: p.minutesToOnline,
    prealertLines,
    activationLines,
    releaseLines,
    logOnByMs: activationDelivered ? (a?.proposed.payload.logOnByMs ?? null) : null,
    expiresAtMs,
    msUntilExpiry: expiresAtMs === null ? null : expiresAtMs - nowMs,
    canRespond: respond !== null,
    respond,
    headline,
    reason,
  };
}

function plainState(status: string, r: StandbyRecord): { headline: string; reason: string | null } {
  switch (status) {
    case 'proposed':
    case 'approved':
    case 'prealert_sent':
      return { headline: 'Waiting for approval', reason: 'The operations team has not sent this standby request yet.' };
    case 'prealert_delivered':
      return { headline: 'Standby request', reason: null };
    case 'acknowledged':
      return { headline: 'Thank you. You are on standby.', reason: `We will only ask you to log on if the coverage need materializes between ${etHm(r.proposal.window.startMs)} and ${etHm(r.proposal.window.endMs)} ET.` };
    case 'activation_proposed':
    case 'activation_approved':
    case 'activation_sent':
      return { headline: 'You are on standby', reason: 'The operations team is preparing an activation request.' };
    case 'activation_delivered':
      return { headline: 'Activation request', reason: null };
    case 'activated':
      return { headline: 'Activated. Thank you.', reason: r.activation?.activated === null || r.activation === null ? null : `You are expected online from ${etHm(r.activation.activated.payload.effectiveStartMs)} until ${etHm(r.activation.activated.payload.endMs)} ET.` };
    case 'activation_declined':
      return { headline: 'Activation declined', reason: 'You declined this activation. You remain on standby only if the operations team asks again.' };
    case 'declined':
      return { headline: 'Not tonight', reason: 'You declined this standby request. No further action is needed.' };
    case 'expired':
      return { headline: 'This request expired', reason: 'It was not answered within 10 minutes.' };
    case 'released':
      return { headline: 'Standby released', reason: 'Thank you. No action is needed.' };
    case 'cancelled':
      return { headline: 'This request was withdrawn', reason: 'The operations team withdrew this standby request.' };
    case 'rejected':
      return { headline: 'This request was not sent', reason: 'The operations team withdrew this standby request.' };
    default:
      return { headline: status, reason: null };
  }
}

export type { ActivationTrigger };
