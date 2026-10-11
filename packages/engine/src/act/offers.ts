import { OFFER_EXPIRY_MINUTES } from '../decide/brief-rules';
import type { OfferLogEntry } from '../decide/types';
import type { AcceptedOffer } from '../detect/staffing';
import { ACCEPTED_OFFER_START, OFFER_CANCEL_ROLES, OFFER_EXPIRY_BOUNDARY } from '../policy';
import type { EpochMs } from '../types';
import { actionsKnownAt } from './log';
import { activatedStandbysOf, standbyOfferLogEntries } from './standby';
import type { ActionEvent, ActionLog, ActorRef, CommandType, FrozenNeed, OfferProposal, Role } from './types';

/**
 * Offer state machine, derived purely from the action log (brief "Act":
 * "track accept/decline/timeout"; "Notification and Safety Constraints"):
 *
 *   proposed -> approved -> sent -> delivered -> accepted | declined | expired | cancelled | superseded
 *   proposed -> rejected | cancelled | superseded
 *
 * Approval emits approved + sent + delivered at the same instant (simulated
 * delivery). Expiry is derived (OQ-36) and materialized lazily by `tick`.
 */

export type OfferStatus = 'proposed' | 'approved' | 'rejected' | 'sent' | 'delivered' | 'accepted' | 'declined' | 'expired' | 'cancelled' | 'superseded';

export const IN_FLIGHT: readonly OfferStatus[] = ['proposed', 'approved', 'sent', 'delivered'];
export const TERMINAL: readonly OfferStatus[] = ['rejected', 'accepted', 'declined', 'expired', 'cancelled', 'superseded'];

interface Stamp {
  readonly atMs: EpochMs;
  readonly by: ActorRef;
  readonly actionId: string;
}

export interface OfferRecord {
  readonly offerId: string;
  readonly proposal: OfferProposal;
  readonly proposed: Stamp;
  approved: (Stamp & { note: string | null }) | null;
  rejected: (Stamp & { reason: string }) | null;
  sent: (Stamp & { channel: string; message: string }) | null;
  delivered: (Stamp & { channel: string; expiresAtMs: EpochMs }) | null;
  /** Terminal event in the log (expired only once materialized by tick). */
  outcome: (Stamp & { status: Exclude<OfferStatus, 'proposed' | 'approved' | 'sent' | 'delivered' | 'rejected'>; event: ActionEvent }) | null;
}

const stamp = (e: ActionEvent): Stamp => ({ atMs: e.atMs, by: e.actor, actionId: e.actionId });

/** All offers in the log known at nowMs, in proposal order. */
export function foldOffers(log: ActionLog, nowMs: EpochMs): OfferRecord[] {
  const byId = new Map<string, OfferRecord>();
  for (const e of actionsKnownAt(log, nowMs)) {
    if (e.type === 'offer_proposed') {
      byId.set(e.payload.offerId, { offerId: e.payload.offerId, proposal: e.payload, proposed: stamp(e), approved: null, rejected: null, sent: null, delivered: null, outcome: null });
      continue;
    }
    if (!('offerId' in e.payload)) continue;
    const r = byId.get(e.payload.offerId);
    if (r === undefined) continue;
    switch (e.type) {
      case 'offer_approved':
        r.approved = { ...stamp(e), note: e.payload.note };
        break;
      case 'offer_rejected':
        r.rejected = { ...stamp(e), reason: e.payload.reason };
        break;
      case 'offer_sent':
        r.sent = { ...stamp(e), channel: e.payload.channel, message: e.payload.message };
        break;
      case 'offer_delivered':
        r.delivered = { ...stamp(e), channel: e.payload.channel, expiresAtMs: e.payload.expiresAtMs };
        break;
      case 'offer_accepted':
      case 'offer_declined':
      case 'offer_expired':
      case 'offer_cancelled':
      case 'offer_superseded':
        r.outcome ??= { ...stamp(e), status: e.type.slice('offer_'.length) as 'accepted', event: e };
        break;
      default:
        break;
    }
  }
  return [...byId.values()];
}

/** OQ-36: the instant an offer delivered at deliveredAt expires. */
export function expiresAt(deliveredAtMs: EpochMs): EpochMs {
  return deliveredAtMs + OFFER_EXPIRY_MINUTES * 60_000;
}

/** OQ-36 boundary (OFFER_EXPIRY_BOUNDARY = 'inclusive'): expired at exactly 10:00 after delivery. */
export function isExpired(deliveredAtMs: EpochMs, nowMs: EpochMs): boolean {
  return OFFER_EXPIRY_BOUNDARY === 'inclusive' ? nowMs >= expiresAt(deliveredAtMs) : nowMs > expiresAt(deliveredAtMs);
}

export function statusOf(r: OfferRecord, nowMs: EpochMs): OfferStatus {
  if (r.outcome !== null) return r.outcome.status;
  if (r.rejected !== null) return 'rejected';
  if (r.delivered !== null) return isExpired(r.delivered.atMs, nowMs) ? 'expired' : 'delivered';
  if (r.sent !== null) return 'sent';
  if (r.approved !== null) return 'approved';
  return 'proposed';
}

export const isInFlight = (r: OfferRecord, nowMs: EpochMs) => IN_FLIGHT.includes(statusOf(r, nowMs));

export interface OfferState {
  readonly offerId: string;
  readonly status: OfferStatus;
  readonly record: OfferRecord;
  /** For a delivered offer awaiting a reply; null otherwise. */
  readonly msUntilExpiry: number | null;
  /** True once the expiry is in the log (offer_expired); derived expiry alone is false. */
  readonly expiryMaterialized: boolean;
}

export function offerState(log: ActionLog, offerId: string, nowMs: EpochMs): OfferState | null {
  const record = foldOffers(log, nowMs).find((r) => r.offerId === offerId);
  return record === undefined ? null : stateOf(record, nowMs);
}

function stateOf(record: OfferRecord, nowMs: EpochMs): OfferState {
  const status = statusOf(record, nowMs);
  return {
    offerId: record.offerId,
    status,
    record,
    msUntilExpiry: status === 'delivered' && record.delivered !== null ? expiresAt(record.delivered.atMs) - nowMs : null,
    expiryMaterialized: record.outcome?.status === 'expired',
  };
}

/** Next actions per role for an offer in a given status (brief "Users and Decision Rights"; for the UI). */
export function allowedActions(status: OfferStatus, expiryMaterialized: boolean): Readonly<Record<Role, readonly CommandType[]>> {
  const cancel = (role: Role): CommandType[] => ((OFFER_CANCEL_ROLES as readonly Role[]).includes(role) ? ['cancelOffer'] : []);
  const none = { coordinator: [], clinical_lead: [], physician: [], system: [] };
  switch (status) {
    case 'proposed':
      return { coordinator: cancel('coordinator'), clinical_lead: ['approveOffer', 'rejectOffer', ...cancel('clinical_lead')], physician: [], system: [] };
    case 'approved':
    case 'sent':
      return { coordinator: cancel('coordinator'), clinical_lead: cancel('clinical_lead'), physician: [], system: [] };
    case 'delivered':
      return { coordinator: cancel('coordinator'), clinical_lead: cancel('clinical_lead'), physician: ['respond'], system: [] };
    case 'expired':
      return expiryMaterialized ? none : { ...none, system: ['tick'] };
    default:
      return none;
  }
}

export interface OfferView {
  readonly offerId: string;
  readonly slotId: string;
  readonly physicianId: string;
  readonly name: string;
  readonly status: OfferStatus;
  readonly needs: readonly FrozenNeed[];
  readonly window: OfferProposal['window'];
  readonly routingScope: readonly string[];
  readonly seededConsultCount: number;
  readonly proposedAtMs: EpochMs;
  readonly deliveredAtMs: EpochMs | null;
  readonly expiresAtMs: EpochMs | null;
  readonly msUntilExpiry: number | null;
  readonly allowedActions: Readonly<Record<Role, readonly CommandType[]>>;
}

/** Every offer known at nowMs with status, timers and allowed next actions per role. */
export function listOffers(log: ActionLog, nowMs: EpochMs): OfferView[] {
  return foldOffers(log, nowMs).map((r) => {
    const s = stateOf(r, nowMs);
    return {
      offerId: r.offerId,
      slotId: r.proposal.slotId,
      physicianId: r.proposal.physicianId,
      name: r.proposal.name,
      status: s.status,
      needs: r.proposal.needs,
      window: r.proposal.window,
      routingScope: r.proposal.routingScope,
      seededConsultCount: r.proposal.seededConsultCount,
      proposedAtMs: r.proposed.atMs,
      deliveredAtMs: r.delivered?.atMs ?? null,
      expiresAtMs: r.delivered === null ? null : expiresAt(r.delivered.atMs),
      msUntilExpiry: s.msUntilExpiry,
      allowedActions: allowedActions(s.status, s.expiryMaterialized),
    };
  });
}

/**
 * The action log as decide()'s offer log (safety constraints): in-flight
 * offers are 'open'; per OQ-41 offers rejected or cancelled before sending
 * never reached the physician and are left out of the weekly count.
 */
export function offerLogEntries(log: ActionLog, nowMs: EpochMs): OfferLogEntry[] {
  return [...offerOnlyLogEntries(log, nowMs), ...standbyOfferLogEntries(log, nowMs)];
}

function offerOnlyLogEntries(log: ActionLog, nowMs: EpochMs): OfferLogEntry[] {
  return foldOffers(log, nowMs).flatMap((r): OfferLogEntry[] => {
    const status = statusOf(r, nowMs);
    if (r.sent === null && (status === 'rejected' || status === 'cancelled' || status === 'superseded')) return [];
    const mapped: OfferLogEntry['status'] = IN_FLIGHT.includes(status) ? 'open' : status === 'accepted' || status === 'declined' || status === 'expired' ? status : 'withdrawn';
    return [{ physicianId: r.proposal.physicianId, sentMs: r.sent?.atMs ?? r.proposed.atMs, status: mapped }];
  });
}

/** OQ-39: when an accepted offer starts counting as staffed. */
export function effectiveStartMs(p: OfferProposal, acceptedAtMs: EpochMs): EpochMs {
  return ACCEPTED_OFFER_START === 'offered_start' ? p.window.startMs : Math.max(p.window.startMs, acceptedAtMs + p.window.minutesToOnline * 60_000);
}

/** Accepted offers as staffing (brief "update projected coverage when someone accepts"). */
export function acceptedOffersOf(log: ActionLog, nowMs: EpochMs): AcceptedOffer[] {
  return [...acceptedOfferShifts(log, nowMs), ...activatedStandbysOf(log, nowMs)];
}

function acceptedOfferShifts(log: ActionLog, nowMs: EpochMs): AcceptedOffer[] {
  return foldOffers(log, nowMs).flatMap((r) =>
    r.outcome?.status === 'accepted' && r.outcome.event.type === 'offer_accepted'
      ? [
          {
            physicianId: r.proposal.physicianId,
            name: r.proposal.name,
            startMs: r.outcome.event.payload.effectiveStartMs,
            endMs: r.outcome.event.payload.endMs,
            scopeHospitalIds: r.proposal.routingScope,
            seededConsultCount: r.proposal.seededConsultCount,
          },
        ]
      : [],
  );
}
