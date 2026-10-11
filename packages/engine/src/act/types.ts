import type { EpochMs } from '../types';
import type { NeedKind } from '../decide/types';

/**
 * Act layer types: brief "Problem to Solve" layer 3 ("Send the offer through an
 * approval step; track accept/decline/timeout; update projected coverage when
 * someone accepts; stop sending offers once the gap is filled"). The action log
 * is ours, append-only and separate from Sevaro's event stream.
 */

/** Brief "Users and Decision Rights": the three people plus the system (internal alerts only). */
export type Role = 'coordinator' | 'clinical_lead' | 'physician' | 'system';

export interface ActorRef {
  readonly role: Role;
  readonly id: string;
}

export type ActionType =
  | 'offer_proposed'
  | 'offer_approved'
  | 'offer_rejected'
  | 'offer_sent'
  | 'offer_delivered'
  | 'offer_accepted'
  | 'offer_declined'
  | 'offer_expired'
  | 'offer_cancelled'
  | 'offer_superseded'
  | 'escalation_raised'
  | 'escalation_authorized'
  | 'reassignment_requested'
  | 'internal_alert_sent'
  // Standby network (Phase 4): pre-alert -> acknowledge -> activation -> online, or release.
  | 'standby_proposed'
  | 'standby_approved'
  | 'standby_rejected'
  | 'standby_prealert_sent'
  | 'standby_prealert_delivered'
  | 'standby_acknowledged'
  | 'standby_declined'
  | 'standby_expired'
  | 'standby_activation_proposed'
  | 'standby_activation_approved'
  | 'standby_activation_rejected'
  | 'standby_activation_sent'
  | 'standby_activation_delivered'
  | 'standby_activated'
  | 'standby_activation_declined'
  | 'standby_released'
  | 'standby_cancelled';

/** One candidate row frozen into a standby proposal (brief: "who was considered, who was excluded and why"). */
export interface FrozenStandbyRow {
  readonly physicianId: string;
  readonly name: string;
  readonly eligible: boolean;
  readonly failingRule: { readonly rule: string; readonly detail: string } | null;
  readonly valueEUM: number;
  readonly selectedRound: number | null;
}

export interface StandbyProposal {
  readonly standbyId: string;
  readonly physicianId: string;
  readonly name: string;
  readonly channel: string;
  readonly decisionAtMs: EpochMs;
  readonly minutesToOnline: number;
  readonly window: { readonly startMs: EpochMs; readonly endMs: EpochMs; readonly minutes: number };
  readonly coveredHospitalIds: readonly string[];
  readonly hospitalNames: readonly string[];
  readonly coveredCells: readonly { readonly hospitalId: string; readonly startMs: EpochMs; readonly pGap: number }[];
  readonly pAccept: number;
  readonly valueEUM: number;
  readonly falseAlarmChance: number;
  readonly candidates: readonly FrozenStandbyRow[];
  readonly planWhy: readonly string[];
  /** The PHI-checked pre-alert text. */
  readonly message: string;
}

export interface ActivationTrigger {
  readonly kind: 'pgap' | 'deadlock' | 'coordinator_override';
  readonly detail: string;
  readonly hospitalId: string | null;
  readonly cellStartMs: EpochMs | null;
  readonly pGap: number | null;
}

/** A need as frozen into an offer at proposal time (audit must not depend on re-running decide). */
export interface FrozenNeed {
  readonly id: string;
  readonly kind: NeedKind;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly startMs: EpochMs;
  readonly endMs: EpochMs | 'beyond_horizon';
}

/** One row of the frozen eligibility ledger: brief "Log every offer: who was considered, who was excluded and why". */
export interface FrozenLedgerRow {
  readonly physicianId: string;
  readonly name: string;
  readonly eligible: boolean;
  readonly rank: number | null;
  readonly failedRules: readonly string[];
  readonly rules: readonly { readonly rule: string; readonly pass: boolean | null; readonly detail: string }[];
}

export interface OfferProposal {
  readonly offerId: string;
  readonly slotId: string;
  readonly dispatchMode: 'sequential' | 'parallel';
  readonly physicianId: string;
  readonly name: string;
  /** physicians_off_shift_roster.csv preferred_channel. */
  readonly channel: string;
  readonly decisionAtMs: EpochMs;
  readonly window: { readonly startMs: EpochMs; readonly endMs: EpochMs; readonly minutesToOnline: number; readonly effectiveMinutes: number; readonly bindingCap: string };
  readonly routingScope: readonly string[];
  readonly hospitalNames: readonly string[];
  readonly seededConsultCount: number;
  readonly value: number;
  readonly needs: readonly FrozenNeed[];
  readonly ledger: readonly FrozenLedgerRow[];
  readonly trapWhy: readonly string[];
  readonly message: string;
}

/** Coverage effect of an acceptance, frozen into offer_accepted (brief "update projected coverage when someone accepts"). */
export interface CoverageEffect {
  readonly changes: readonly { readonly needId: string; readonly kind: NeedKind; readonly hospitalId: string; readonly startMs: EpochMs; readonly endMs: EpochMs | 'beyond_horizon'; readonly outcome: string; readonly detail: string }[];
  readonly routableAtStart: readonly { readonly hospitalId: string; readonly atMs: EpochMs; readonly count: number }[];
  readonly filledNeedIds: readonly string[];
}

export interface EscalationSubject {
  readonly needId?: string;
  readonly attentionItemId?: string;
  readonly consultIds?: readonly string[];
  readonly hospitalIds?: readonly string[];
}

export type ActionPayload =
  | { readonly type: 'offer_proposed'; readonly payload: OfferProposal }
  | { readonly type: 'offer_approved'; readonly payload: { readonly offerId: string; readonly note: string | null } }
  | { readonly type: 'offer_rejected'; readonly payload: { readonly offerId: string; readonly reason: string } }
  | { readonly type: 'offer_sent'; readonly payload: { readonly offerId: string; readonly channel: string; readonly message: string } }
  | { readonly type: 'offer_delivered'; readonly payload: { readonly offerId: string; readonly channel: string; readonly simulated: true; readonly expiresAtMs: EpochMs } }
  | { readonly type: 'offer_accepted'; readonly payload: { readonly offerId: string; readonly effectiveStartMs: EpochMs; readonly endMs: EpochMs; readonly coverageEffect: CoverageEffect } }
  | { readonly type: 'offer_declined'; readonly payload: { readonly offerId: string } }
  | { readonly type: 'offer_expired'; readonly payload: { readonly offerId: string; readonly expiredAtMs: EpochMs } }
  | { readonly type: 'offer_cancelled'; readonly payload: { readonly offerId: string; readonly reason: string; readonly cause: 'manual' | 'gap_filled'; readonly filledBy: string | null } }
  | { readonly type: 'offer_superseded'; readonly payload: { readonly offerId: string; readonly slotId: string; readonly wonBy: string; readonly reason: string } }
  | { readonly type: 'escalation_raised'; readonly payload: { readonly escalationId: string; readonly subject: EscalationSubject; readonly reason: string } }
  | { readonly type: 'escalation_authorized'; readonly payload: { readonly escalationId: string; readonly note: string | null } }
  | {
      readonly type: 'reassignment_requested';
      readonly payload: { readonly consultId: string; readonly hospitalId: string; readonly fromPhysicianId: string | null; readonly toPhysicianId: string; readonly label: 'requested in Synapse'; readonly why: string };
    }
  | { readonly type: 'internal_alert_sent'; readonly payload: { readonly alertId: string; readonly message: string; readonly physicianIds: readonly string[]; readonly automated: boolean } }
  | { readonly type: 'standby_proposed'; readonly payload: StandbyProposal }
  | { readonly type: 'standby_approved'; readonly payload: { readonly standbyId: string; readonly note: string | null } }
  | { readonly type: 'standby_rejected'; readonly payload: { readonly standbyId: string; readonly reason: string } }
  | { readonly type: 'standby_prealert_sent'; readonly payload: { readonly standbyId: string; readonly channel: string; readonly message: string } }
  | { readonly type: 'standby_prealert_delivered'; readonly payload: { readonly standbyId: string; readonly channel: string; readonly simulated: true; readonly expiresAtMs: EpochMs } }
  | { readonly type: 'standby_acknowledged'; readonly payload: { readonly standbyId: string } }
  | { readonly type: 'standby_declined'; readonly payload: { readonly standbyId: string } }
  | { readonly type: 'standby_expired'; readonly payload: { readonly standbyId: string; readonly stage: 'prealert' | 'activation'; readonly expiredAtMs: EpochMs } }
  | {
      readonly type: 'standby_activation_proposed';
      readonly payload: { readonly standbyId: string; readonly trigger: ActivationTrigger; readonly logOnByMs: EpochMs; readonly endMs: EpochMs; readonly scopeHospitalIds: readonly string[]; readonly hospitalNames: readonly string[]; readonly seededConsultCount: number; readonly trapWhy: readonly string[]; readonly message: string };
    }
  | { readonly type: 'standby_activation_approved'; readonly payload: { readonly standbyId: string; readonly note: string | null } }
  | { readonly type: 'standby_activation_rejected'; readonly payload: { readonly standbyId: string; readonly reason: string } }
  | { readonly type: 'standby_activation_sent'; readonly payload: { readonly standbyId: string; readonly channel: string; readonly message: string } }
  | { readonly type: 'standby_activation_delivered'; readonly payload: { readonly standbyId: string; readonly channel: string; readonly simulated: true; readonly expiresAtMs: EpochMs } }
  | {
      readonly type: 'standby_activated';
      readonly payload: { readonly standbyId: string; readonly effectiveStartMs: EpochMs; readonly endMs: EpochMs; readonly scopeHospitalIds: readonly string[]; readonly seededConsultCount: number; readonly coverageEffect: CoverageEffect };
    }
  | { readonly type: 'standby_activation_declined'; readonly payload: { readonly standbyId: string } }
  | { readonly type: 'standby_released'; readonly payload: { readonly standbyId: string; readonly reason: string; readonly message: string } }
  | { readonly type: 'standby_cancelled'; readonly payload: { readonly standbyId: string; readonly reason: string } };

export type ActionEvent = {
  /** Deterministic: hash of commandId and the event's index within the command. */
  readonly actionId: string;
  /** 1-based position in the log. */
  readonly seq: number;
  /** Sim-clock time the command was applied. */
  readonly atMs: EpochMs;
  readonly actor: ActorRef;
  /** Idempotency key of the command that produced this event. */
  readonly commandId: string;
} & ActionPayload;

export type ActionLog = readonly ActionEvent[];

interface CommandBase {
  readonly commandId: string;
  readonly actor: ActorRef;
  /** Optimistic concurrency: the log head seq the caller saw; mismatch -> CONFLICT. */
  readonly expectedSeq?: number;
}

export type Command =
  | (CommandBase & { readonly type: 'proposeOffer'; readonly physicianId: string; readonly needIds?: readonly string[]; readonly slotId?: string })
  | (CommandBase & { readonly type: 'proposeSlot'; readonly needIds?: readonly string[]; readonly k?: number })
  | (CommandBase & { readonly type: 'approveOffer'; readonly offerId: string; readonly note?: string })
  | (CommandBase & { readonly type: 'rejectOffer'; readonly offerId: string; readonly reason?: string })
  | (CommandBase & { readonly type: 'respond'; readonly offerId: string; readonly physicianId: string; readonly response: 'accept' | 'decline' })
  | (CommandBase & { readonly type: 'cancelOffer'; readonly offerId: string; readonly reason: string })
  | (CommandBase & { readonly type: 'tick' })
  | (CommandBase & { readonly type: 'raiseEscalation'; readonly subject: EscalationSubject; readonly reason: string })
  | (CommandBase & { readonly type: 'authorizeEscalation'; readonly escalationId: string; readonly note?: string })
  | (CommandBase & { readonly type: 'requestReassignment'; readonly consultId: string; readonly toPhysicianId: string })
  | (CommandBase & { readonly type: 'sendInternalAlert'; readonly message: string; readonly physicianIds?: readonly string[] })
  // Standby network (Phase 4). Roles follow DECISION_RIGHTS.SPLIT_SHIFT_OFFER: coordinator proposes, clinical lead approves, the physician answers on the phone.
  | (CommandBase & { readonly type: 'proposeStandby'; readonly physicianId: string })
  | (CommandBase & { readonly type: 'approveStandby'; readonly standbyId: string; readonly note?: string })
  | (CommandBase & { readonly type: 'rejectStandby'; readonly standbyId: string; readonly reason?: string })
  | (CommandBase & { readonly type: 'respondStandby'; readonly standbyId: string; readonly physicianId: string; readonly response: 'ready' | 'not_tonight' })
  | (CommandBase & { readonly type: 'proposeActivation'; readonly standbyId: string; readonly force?: boolean; readonly reason?: string })
  | (CommandBase & { readonly type: 'approveActivation'; readonly standbyId: string; readonly note?: string })
  | (CommandBase & { readonly type: 'rejectActivation'; readonly standbyId: string; readonly reason?: string })
  | (CommandBase & { readonly type: 'respondActivation'; readonly standbyId: string; readonly physicianId: string; readonly response: 'accept' | 'decline' })
  | (CommandBase & { readonly type: 'releaseStandby'; readonly standbyId: string; readonly reason?: string })
  | (CommandBase & { readonly type: 'cancelStandby'; readonly standbyId: string; readonly reason: string });

export type CommandType = Command['type'];

export type ErrorCode =
  | 'FORBIDDEN_ROLE'
  | 'NOT_OWN_OFFER'
  | 'NOT_ELIGIBLE'
  | 'OPEN_OFFER_EXISTS'
  | 'WEEKLY_CAP'
  | 'EXPIRED'
  | 'NO_LONGER_AVAILABLE'
  | 'INVALID_STATE'
  | 'PHI_BLOCKED'
  | 'CONFLICT'
  | 'UNKNOWN_OFFER'
  | 'NEED_ALREADY_FILLED'
  | 'UNKNOWN_STANDBY';

export type CommandResult =
  | {
      readonly ok: true;
      readonly log: ActionLog;
      readonly emitted: readonly ActionEvent[];
      /** True when the commandId was already applied: the original events are returned, nothing is appended. */
      readonly replayed: boolean;
      /** For an acceptance: coverage before/after (also frozen in the offer_accepted payload). */
      readonly coverage: CoverageEffect | null;
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };
