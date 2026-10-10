import type { Severity } from '../detect/attention';
import type { RouteCandidate } from '../detect/routing';
import type { RuleCode } from '../replay/rules';
import type { EventRef } from '../replay/types';
import type { EpochMs } from '../types';
import type { Actor, InterventionKind } from './brief-rules';

export type NeedKind = 'DEADLOCK_NOW' | 'AT_RISK' | 'HARD_GAP';

export interface Need {
  readonly id: string;
  readonly kind: NeedKind;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly startMs: EpochMs;
  /** 'beyond_horizon' = still unresolved at the end of the decision projection (OQ-31). */
  readonly endMs: EpochMs | 'beyond_horizon';
  readonly severity: Severity;
  readonly strokeAtRisk: boolean;
  readonly consultIds: readonly string[];
  readonly attentionItemIds: readonly string[];
  /** OQ-30: whether this need makes its hospital a "hospital with the gap" for split-shift offers. */
  readonly qualifiesForOffers: boolean;
  readonly required: number | null;
  readonly staffedConfirmed: number | null;
  readonly staffedExpected: number | null;
  readonly rule: RuleCode;
  readonly why: readonly string[];
  readonly because: readonly EventRef[];
}

export interface GapHospital {
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly needIds: readonly string[];
  readonly kinds: readonly NeedKind[];
  readonly qualifiesForOffers: boolean;
}

/** Minimal offer log (Session 5 owns the state machine); used for the safety-constraint rules. */
export interface OfferLogEntry {
  readonly physicianId: string;
  readonly sentMs: EpochMs;
  readonly status: 'open' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
}

export interface WindowCap {
  readonly kind: 'needs_end' | 'max_offer_hours' | 'next_scheduled_shift' | 'hours_headroom';
  readonly atMs: EpochMs;
  readonly detail: string;
}

export interface OfferWindow {
  /** When the offer would be sent (now). */
  readonly sentMs: EpochMs;
  /** Offered start = now + estimated minutes to come online. */
  readonly startMs: EpochMs;
  readonly endMs: EpochMs;
  readonly minutesToOnline: number;
  /** end - sent: the window as offered. */
  readonly offeredMinutes: number;
  /** end - start = offered minus time to come online (OQ-08). */
  readonly effectiveMinutes: number;
  readonly caps: readonly WindowCap[];
  readonly bindingCap: WindowCap['kind'];
}

export interface EligibilityRule {
  readonly rule: RuleCode;
  /** null = not applicable (e.g. no covered need to size an offer against). */
  readonly pass: boolean | null;
  readonly detail: string;
  readonly because: readonly EventRef[];
}

export interface ValueTerm {
  readonly needId: string;
  readonly kind: NeedKind;
  readonly hospitalId: string;
  readonly minutes: number;
  readonly weight: number;
  readonly points: number;
}

export interface LedgerEntry {
  readonly physicianId: string;
  readonly name: string;
  readonly eligible: boolean;
  readonly rules: readonly EligibilityRule[];
  readonly offerWindow: OfferWindow | null;
  /** Qualifying needs (OQ-30) at hospitals where the physician is credentialed. */
  readonly coversNeeds: readonly string[];
  /** Hospitals of the covered qualifying needs: the offer's routing scope. */
  readonly scopeHospitalIds: readonly string[];
  readonly value: number | null;
  readonly valueTerms: readonly ValueTerm[];
  readonly rank: number | null;
  readonly rankWhy: readonly string[];
}

export interface PrioritySnapshotRow {
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly inScope: boolean;
  readonly joinerConsults: number;
  readonly joinerTier: 'low_volume_priority' | 'fewest_consults';
  readonly competitors: readonly { readonly physicianId: string; readonly consults: number; readonly tier: 'low_volume_priority' | 'fewest_consults' }[];
  readonly firstPick: boolean;
  readonly why: string;
}

export interface TrapAnalysis {
  readonly physicianId: string;
  readonly source: 'split_shift_offer' | 'scheduled_arrival';
  /** Advisory only for scheduled arrivals (their routing is not ours to scope). */
  readonly advisory: boolean;
  readonly startMs: EpochMs;
  readonly dayShift: boolean;
  readonly lowVolumeLimit: number;
  readonly credentialedHospitalIds: readonly string[];
  readonly scopeHospitalIds: readonly string[] | null;
  readonly credentialedOutsideScope: readonly string[];
  readonly before: readonly PrioritySnapshotRow[];
  readonly after: readonly PrioritySnapshotRow[];
  readonly seededConsultCount: number;
  readonly seedBasis: readonly { readonly physicianId: string; readonly consults: number }[];
  readonly recommended: 'scope' | 'seed' | 'scope_and_seed';
  readonly trapWhy: readonly string[];
}

export interface RecommendedOffer {
  readonly physicianId: string;
  readonly name: string;
  readonly window: OfferWindow;
  readonly routingScope: readonly string[];
  readonly seededConsultCount: number;
  readonly value: number;
  readonly coversNeeds: readonly string[];
  readonly why: readonly string[];
  readonly message: string;
  readonly trap: TrapAnalysis;
}

export interface Intervention {
  readonly id: string;
  readonly kind: InterventionKind;
  readonly targets: { readonly consultIds: readonly string[]; readonly physicianIds: readonly string[]; readonly hospitalIds: readonly string[] };
  readonly proposer: Actor;
  readonly approver: Actor | null;
  readonly acceptor: Actor | null;
  /** True only for internal coordinator alerts (brief: automation only for low-risk steps). */
  readonly automationAllowed: boolean;
  /** For REASSIGN_CONSULT: ranked routable candidates (empty = no routable candidate). */
  readonly candidates: readonly RouteCandidate[];
  readonly expectedEffect: string;
  readonly why: readonly string[];
  readonly because: readonly EventRef[];
  readonly linkedAttentionIds: readonly string[];
  readonly linkedNeedIds: readonly string[];
}

export interface TopIssueRecommendation {
  readonly attentionItemId: string;
  readonly headline: string;
  readonly actions: readonly Intervention[];
  readonly rationale: readonly string[];
}
