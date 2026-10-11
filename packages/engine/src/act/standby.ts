import { DateTime } from 'luxon';
import { OFFER_EXPIRY_MINUTES } from '../decide/brief-rules';
import { findPhiViolations } from '../decide/phi';
import type { OfferLogEntry } from '../decide/types';
import type { AcceptedOffer } from '../detect/staffing';
import { etClock } from '../detect/staffing';
import { buildForecastModel, type HawkesFit } from '../forecast';
import { OFFER_EXPIRY_BOUNDARY, STANDBY_ACTIVATE_LEAD_MIN, STANDBY_ACTIVATE_PGAP, STANDBY_COUNTS_AS_OFFER, STANDBY_RECOMPUTE_MIN, STANDBY_RELEASE_PGAP } from '../policy';
import { buildStandbyPlan, type StandbyPlan } from '../standby';
import { activationMessage, preAlertMessage, releaseMessage, STANDBY_MESSAGE_VOCABULARY } from '../standby/messages';
import { ET_ZONE } from '../time';
import type { EpochMs } from '../types';
import { fnv1a } from '../util/hash';
import { actionsKnownAt } from './log';
import type { ActionEvent, ActionLog, ActorRef, ActivationTrigger, CommandType, Role, StandbyProposal } from './types';

/**
 * Standby lifecycle (Phase 4.4), folded purely from the action log like the
 * offer state machine (D-59):
 *
 *   proposed -> approved -> prealert_sent -> prealert_delivered
 *     -> acknowledged ("I can be ready") | declined | expired(prealert)
 *   proposed -> rejected; any in-flight -> cancelled
 *   acknowledged -> activation_proposed -> activation_approved -> activation_sent -> activation_delivered
 *     -> activated | activation_declined | expired(activation) (back to acknowledged for a new attempt)
 *   acknowledged -> released
 *
 * Roles reuse DECISION_RIGHTS (coordinator proposes, clinical lead approves,
 * physician answers); the 10-minute expiry (brief) applies to the pre-alert
 * and to the activation request; every message passes assertNoPHI.
 */

export type StandbyStatus =
  | 'proposed'
  | 'approved'
  | 'prealert_sent'
  | 'prealert_delivered'
  | 'acknowledged'
  | 'declined'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'activation_proposed'
  | 'activation_approved'
  | 'activation_sent'
  | 'activation_delivered'
  | 'activated'
  | 'activation_declined'
  | 'released';

export const STANDBY_IN_FLIGHT: readonly StandbyStatus[] = ['proposed', 'approved', 'prealert_sent', 'prealert_delivered', 'acknowledged', 'activation_proposed', 'activation_approved', 'activation_sent', 'activation_delivered', 'activation_declined'];

interface Stamp {
  readonly atMs: EpochMs;
  readonly by: ActorRef;
  readonly actionId: string;
}

export interface StandbyRecord {
  readonly standbyId: string;
  readonly proposal: StandbyProposal;
  readonly proposed: Stamp;
  approved: (Stamp & { note: string | null }) | null;
  rejected: (Stamp & { reason: string }) | null;
  prealertSent: (Stamp & { message: string }) | null;
  prealertDelivered: (Stamp & { expiresAtMs: EpochMs }) | null;
  acknowledged: Stamp | null;
  declined: Stamp | null;
  /** The latest activation attempt (a new proposeActivation after an expiry or decline starts a new one). */
  activation: {
    proposed: Stamp & { payload: Extract<ActionEvent, { type: 'standby_activation_proposed' }>['payload'] };
    approved: (Stamp & { note: string | null }) | null;
    rejected: (Stamp & { reason: string }) | null;
    sent: (Stamp & { message: string }) | null;
    delivered: (Stamp & { expiresAtMs: EpochMs }) | null;
    activated: (Stamp & { payload: Extract<ActionEvent, { type: 'standby_activated' }>['payload'] }) | null;
    declined: Stamp | null;
    expired: (Stamp & { expiredAtMs: EpochMs }) | null;
  } | null;
  prealertExpired: (Stamp & { expiredAtMs: EpochMs }) | null;
  released: (Stamp & { reason: string; message: string }) | null;
  cancelled: (Stamp & { reason: string }) | null;
}

const stamp = (e: ActionEvent): Stamp => ({ atMs: e.atMs, by: e.actor, actionId: e.actionId });

/** Same expiry rule as offers (OQ-36), restated here only to avoid an import cycle with offers.ts. */
const expiresAt = (deliveredAtMs: EpochMs): EpochMs => deliveredAtMs + OFFER_EXPIRY_MINUTES * 60_000;
const isExpired = (deliveredAtMs: EpochMs, nowMs: EpochMs): boolean => (OFFER_EXPIRY_BOUNDARY === 'inclusive' ? nowMs >= expiresAt(deliveredAtMs) : nowMs > expiresAt(deliveredAtMs));

export function foldStandbys(log: ActionLog, nowMs: EpochMs): StandbyRecord[] {
  const byId = new Map<string, StandbyRecord>();
  for (const e of actionsKnownAt(log, nowMs)) {
    if (e.type === 'standby_proposed') {
      byId.set(e.payload.standbyId, {
        standbyId: e.payload.standbyId,
        proposal: e.payload,
        proposed: stamp(e),
        approved: null,
        rejected: null,
        prealertSent: null,
        prealertDelivered: null,
        acknowledged: null,
        declined: null,
        activation: null,
        prealertExpired: null,
        released: null,
        cancelled: null,
      });
      continue;
    }
    if (!e.type.startsWith('standby_') || !('standbyId' in e.payload)) continue;
    const r = byId.get(e.payload.standbyId);
    if (r === undefined) continue;
    switch (e.type) {
      case 'standby_approved':
        r.approved = { ...stamp(e), note: e.payload.note };
        break;
      case 'standby_rejected':
        r.rejected = { ...stamp(e), reason: e.payload.reason };
        break;
      case 'standby_prealert_sent':
        r.prealertSent = { ...stamp(e), message: e.payload.message };
        break;
      case 'standby_prealert_delivered':
        r.prealertDelivered = { ...stamp(e), expiresAtMs: e.payload.expiresAtMs };
        break;
      case 'standby_acknowledged':
        r.acknowledged = stamp(e);
        break;
      case 'standby_declined':
        r.declined = stamp(e);
        break;
      case 'standby_expired':
        if (e.payload.stage === 'prealert') r.prealertExpired = { ...stamp(e), expiredAtMs: e.payload.expiredAtMs };
        else if (r.activation !== null) r.activation.expired = { ...stamp(e), expiredAtMs: e.payload.expiredAtMs };
        break;
      case 'standby_activation_proposed':
        r.activation = { proposed: { ...stamp(e), payload: e.payload }, approved: null, rejected: null, sent: null, delivered: null, activated: null, declined: null, expired: null };
        break;
      case 'standby_activation_approved':
        if (r.activation) r.activation.approved = { ...stamp(e), note: e.payload.note };
        break;
      case 'standby_activation_rejected':
        if (r.activation) r.activation.rejected = { ...stamp(e), reason: e.payload.reason };
        break;
      case 'standby_activation_sent':
        if (r.activation) r.activation.sent = { ...stamp(e), message: e.payload.message };
        break;
      case 'standby_activation_delivered':
        if (r.activation) r.activation.delivered = { ...stamp(e), expiresAtMs: e.payload.expiresAtMs };
        break;
      case 'standby_activated':
        if (r.activation) r.activation.activated = { ...stamp(e), payload: e.payload };
        break;
      case 'standby_activation_declined':
        if (r.activation) r.activation.declined = stamp(e);
        break;
      case 'standby_released':
        r.released = { ...stamp(e), reason: e.payload.reason, message: e.payload.message };
        break;
      case 'standby_cancelled':
        r.cancelled = { ...stamp(e), reason: e.payload.reason };
        break;
      default:
        break;
    }
  }
  return [...byId.values()];
}

export function standbyStatus(r: StandbyRecord, nowMs: EpochMs): StandbyStatus {
  if (r.cancelled !== null) return 'cancelled';
  if (r.released !== null) return 'released';
  if (r.rejected !== null) return 'rejected';
  if (r.declined !== null) return 'declined';
  if (r.prealertExpired !== null) return 'expired';
  const a = r.activation;
  if (a !== null) {
    if (a.activated !== null) return 'activated';
    if (a.declined !== null) return 'activation_declined';
    if (a.rejected !== null) return 'acknowledged'; // the lead declined to activate; the standby stays acknowledged
    if (a.expired !== null) return 'acknowledged'; // the activation request lapsed; a new one may be proposed
    if (a.delivered !== null) return isExpired(a.delivered.atMs, nowMs) ? 'acknowledged' : 'activation_delivered';
    if (a.sent !== null) return 'activation_sent';
    if (a.approved !== null) return 'activation_approved';
    return 'activation_proposed';
  }
  if (r.acknowledged !== null) return 'acknowledged';
  if (r.prealertDelivered !== null) return isExpired(r.prealertDelivered.atMs, nowMs) ? 'expired' : 'prealert_delivered';
  if (r.prealertSent !== null) return 'prealert_sent';
  if (r.approved !== null) return 'approved';
  return 'proposed';
}

export const standbyInFlight = (r: StandbyRecord, nowMs: EpochMs): boolean => STANDBY_IN_FLIGHT.includes(standbyStatus(r, nowMs)) && standbyStatus(r, nowMs) !== 'activation_declined';

/** True while the latest activation request is delivered and past its 10-minute expiry but not yet materialized by tick. */
export function activationLapsed(r: StandbyRecord, nowMs: EpochMs): boolean {
  const a = r.activation;
  return a !== null && a.delivered !== null && a.activated === null && a.declined === null && a.expired === null && isExpired(a.delivered.atMs, nowMs);
}

/** Activated standbys as staffing (scope + seed honoured), merged into acceptedOffersOf. */
export function activatedStandbysOf(log: ActionLog, nowMs: EpochMs): AcceptedOffer[] {
  return foldStandbys(log, nowMs).flatMap((r) => {
    const a = r.activation?.activated;
    if (a === undefined || a === null) return [];
    return [{ physicianId: r.proposal.physicianId, name: r.proposal.name, startMs: a.payload.effectiveStartMs, endMs: a.payload.endMs, scopeHospitalIds: a.payload.scopeHospitalIds, seededConsultCount: a.payload.seededConsultCount }];
  });
}

/** OQ-48: an open standby is the physician's open offer; a sent pre-alert counts toward 3 per week. */
export function standbyOfferLogEntries(log: ActionLog, nowMs: EpochMs): OfferLogEntry[] {
  if (!STANDBY_COUNTS_AS_OFFER) return [];
  return foldStandbys(log, nowMs).flatMap((r): OfferLogEntry[] => {
    const status = standbyStatus(r, nowMs);
    if (r.prealertSent === null && (status === 'rejected' || status === 'cancelled')) return [];
    const mapped: OfferLogEntry['status'] = standbyInFlight(r, nowMs) ? 'open' : status === 'activated' ? 'accepted' : status === 'declined' || status === 'activation_declined' ? 'declined' : status === 'expired' ? 'expired' : 'withdrawn';
    return [{ physicianId: r.proposal.physicianId, sentMs: r.prealertSent?.atMs ?? r.proposed.atMs, status: mapped }];
  });
}

/** Fairness guard inputs (4.5): pre-alerts sent tonight (same ET date) and alerts (pre-alerts + offers) in the trailing 7 days. */
export function standbyHistoryOf(log: ActionLog, nowMs: EpochMs): { preAlertsTonight: Map<string, number>; alerts7d: Map<string, number> } {
  const tonight = DateTime.fromMillis(nowMs, { zone: ET_ZONE }).toISODate();
  const weekAgo = nowMs - 7 * 24 * 3_600_000;
  const preAlertsTonight = new Map<string, number>();
  const alerts7d = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const r of foldStandbys(log, nowMs)) {
    const sent = r.prealertSent?.atMs ?? null;
    if (sent === null) continue;
    if (DateTime.fromMillis(sent, { zone: ET_ZONE }).toISODate() === tonight) bump(preAlertsTonight, r.proposal.physicianId);
    if (sent >= weekAgo) bump(alerts7d, r.proposal.physicianId);
  }
  for (const e of actionsKnownAt(log, nowMs)) if (e.type === 'offer_sent' && e.atMs >= weekAgo) bump(alerts7d, (log.find((x) => x.type === 'offer_proposed' && x.payload.offerId === e.payload.offerId)?.payload as { physicianId?: string } | undefined)?.physicianId ?? '');
  return { preAlertsTonight, alerts7d };
}

// ---------------------------------------------------------------- plan + triggers

export interface PlanContext {
  readonly plan: StandbyPlan;
  readonly fit: HawkesFit;
}

/**
 * The standby plan at nowMs over the log: decide() with the log's offers (plus
 * activated standbys as staffing), the surge forecast (fit memoizable by the
 * caller), the fairness history, then the greedy plan.
 */
export function planFromDecision(
  dataset: Parameters<typeof buildStandbyPlan>[0]['dataset'],
  decision: Parameters<typeof buildStandbyPlan>[0]['decision'],
  log: ActionLog,
  nowMs: EpochMs,
  offerLog: readonly OfferLogEntry[],
  acceptedOffers: readonly AcceptedOffer[],
  fit?: HawkesFit,
): PlanContext {
  const model = buildForecastModel(dataset, decision.detection.state, nowMs, fit === undefined ? {} : { fit });
  const plan = buildStandbyPlan({ dataset, decision, model, nowMs, offerLog, acceptedOffers, history: standbyHistoryOf(log, nowMs) });
  return { plan, fit: model.fit };
}

/**
 * Activation trigger (4.4.2), evaluated on the CURRENT grid over the frozen
 * covered hospitals and window: a covered cell with P(gap) >= 0.6 starting
 * within time-to-online + 15 min, or a covered hospital deadlocked now.
 */
export function activationTrigger(plan: StandbyPlan, p: StandbyProposal, nowMs: EpochMs, deadlockHospitals: readonly string[]): ActivationTrigger | null {
  const deadlocked = p.coveredHospitalIds.find((h) => deadlockHospitals.includes(h));
  if (deadlocked !== undefined) return { kind: 'deadlock', detail: `${deadlocked} is deadlocked now (routing rule 5): a credentialed physician relieves it`, hospitalId: deadlocked, cellStartMs: nowMs, pGap: 1 };
  const leadMs = (p.minutesToOnline + STANDBY_ACTIVATE_LEAD_MIN) * 60_000;
  const hit = plan.cells
    .filter((c) => p.coveredHospitalIds.includes(c.hospitalId) && c.startMs >= p.window.startMs - 15 * 60_000 && c.startMs < p.window.endMs && c.startMs <= nowMs + leadMs && c.pGap >= STANDBY_ACTIVATE_PGAP && c.coverableByOne)
    .sort((a, b) => b.pGap - a.pGap || a.startMs - b.startMs)[0];
  if (hit === undefined) return null;
  return { kind: 'pgap', detail: `${hit.hospitalName}: P(gap) ${hit.pGap} at ${etClock(hit.startMs)} ET (>= ${STANDBY_ACTIVATE_PGAP}), within ${p.minutesToOnline} + ${STANDBY_ACTIVATE_LEAD_MIN} min`, hospitalId: hit.hospitalId, cellStartMs: hit.startMs, pGap: hit.pGap };
}

/** Quiet at t: no remaining covered cell (start >= t) with P(gap) >= STANDBY_RELEASE_PGAP. */
export function quietAt(plan: StandbyPlan, p: StandbyProposal, tMs: EpochMs): boolean {
  return !plan.cells.some((c) => p.coveredHospitalIds.includes(c.hospitalId) && c.startMs >= tMs && c.startMs < p.window.endMs && c.pGap >= STANDBY_RELEASE_PGAP);
}

export const RECOMPUTE_MS = STANDBY_RECOMPUTE_MIN * 60_000;

// ---------------------------------------------------------------- messages, ids

export const standbyIdOf = (commandId: string, physicianId: string): string => `sb-${fnv1a(`${commandId}|${physicianId}`)}`;

export function phiCheck(text: string, hospitalNames: readonly string[]): string[] {
  return findPhiViolations(text, { allowedWords: STANDBY_MESSAGE_VOCABULARY, allowedPhrases: hospitalNames }).map((v) => `"${v.token}" (${v.label})`);
}

export { preAlertMessage, activationMessage, releaseMessage };

/** Allowed next commands per role for a standby in a given status (for the UI). */
export function standbyAllowedActions(status: StandbyStatus, activationRecommended: boolean, standDownRecommended: boolean): Readonly<Record<Role, readonly CommandType[]>> {
  const none: Record<Role, CommandType[]> = { coordinator: [], clinical_lead: [], physician: [], system: [] };
  switch (status) {
    case 'proposed':
      return { ...none, coordinator: ['cancelStandby'], clinical_lead: ['approveStandby', 'rejectStandby', 'cancelStandby'] };
    case 'approved':
    case 'prealert_sent':
      return { ...none, coordinator: ['cancelStandby'], clinical_lead: ['cancelStandby'] };
    case 'prealert_delivered':
      return { ...none, coordinator: ['cancelStandby'], clinical_lead: ['cancelStandby'], physician: ['respondStandby'] };
    case 'acknowledged':
      return { ...none, coordinator: [...(activationRecommended ? ['proposeActivation' as const] : []), 'cancelStandby'], clinical_lead: [...(standDownRecommended ? ['releaseStandby' as const] : []), 'releaseStandby', 'cancelStandby'] };
    case 'activation_proposed':
      return { ...none, coordinator: ['cancelStandby'], clinical_lead: ['approveActivation', 'rejectActivation', 'cancelStandby'] };
    case 'activation_approved':
    case 'activation_sent':
      return { ...none, coordinator: ['cancelStandby'], clinical_lead: ['cancelStandby'] };
    case 'activation_delivered':
      return { ...none, coordinator: ['cancelStandby'], clinical_lead: ['cancelStandby'], physician: ['respondActivation'] };
    default:
      return none;
  }
}

export const standbyExpiresAt = (deliveredAtMs: EpochMs): EpochMs => expiresAt(deliveredAtMs);
export const STANDBY_EXPIRY_MINUTES = OFFER_EXPIRY_MINUTES;
