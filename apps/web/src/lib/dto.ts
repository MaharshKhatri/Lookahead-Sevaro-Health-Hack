/**
 * Server -> client contract for the Command Center. Every value here is
 * engine output reshaped for display; nothing is re-derived in the browser.
 * Type-only imports from the engine (erased at build), so this file is safe
 * in client components.
 */
import type { CoverageEffect, FrozenLedgerRow, FrozenNeed, Need, OfferStatus, PrioritySnapshotRow } from '@lookahead/engine';

export type UiRole = 'coordinator' | 'clinical_lead' | 'physician';
export type ClockMode = 'paused' | 'playing';
export type ClockSpeed = 1 | 10 | 60;

export interface ClockDTO {
  readonly nowMs: number;
  readonly mode: ClockMode;
  readonly speed: ClockSpeed;
  /** The reference "now" of the data package (18:20 ET). */
  readonly snapshotMs: number;
  readonly scenarioDate: string;
}

export interface EvidenceDTO {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventTimeMs: number;
}

export interface AttentionDTO {
  readonly rank: number;
  readonly id: string;
  readonly kind: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly strokeAtRisk: boolean;
  readonly headline: string;
  readonly timeToImpactMs: number;
  readonly score: number;
  readonly scoreBreakdown: readonly { readonly factor: string; readonly points: number }[];
  readonly why: readonly string[];
  readonly because: readonly EvidenceDTO[];
  readonly consultIds: readonly string[];
  readonly hospitalIds: readonly string[];
  readonly physicianIds: readonly string[];
}

export type CellClass = 'OK' | 'AT_RISK' | 'HARD_GAP' | 'DEADLOCK';

export interface CoverageCellDTO {
  readonly startMs: number;
  readonly endMs: number;
  /** The projection point the numbers come from (the worst point in the bucket). */
  readonly atMs: number;
  readonly required: number;
  readonly staffedConfirmed: number;
  readonly staffedExpected: number;
  readonly class: CellClass;
  readonly expectedIds: readonly string[];
  readonly staffedIds: readonly string[];
  readonly needIds: readonly string[];
}

export interface CoverageRowDTO {
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly worst: CellClass;
  readonly routableNow: number;
  readonly cells: readonly CoverageCellDTO[];
}

export interface ShiftMarkerDTO {
  readonly atMs: number;
  readonly ends: readonly { readonly physicianId: string; readonly name: string | null }[];
  readonly starts: readonly { readonly physicianId: string; readonly name: string | null; readonly confirmation: 'roster' | 'confirmed' | 'expected'; readonly source: string }[];
  readonly label: string;
}

export interface CoverageGridDTO {
  readonly nowMs: number;
  readonly bucketMin: number;
  /** End of the 120-min detection horizon ("next 2 hours"). */
  readonly detectionHorizonEndMs: number;
  /** End of the 300-min decision projection (OQ-31). */
  readonly horizonEndMs: number;
  readonly buckets: readonly { readonly startMs: number; readonly endMs: number }[];
  readonly rows: readonly CoverageRowDTO[];
  readonly markers: readonly ShiftMarkerDTO[];
}

export interface DemandChipDTO {
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly count: number;
  readonly p90: number | null;
  readonly mean: number | null;
  readonly baselineHourEt: string | null;
  readonly contributingConsultIds: readonly string[];
}

export interface LedgerRuleDTO {
  readonly rule: string;
  readonly label: string;
  readonly pass: boolean | null;
  /** Short chip text with the rule's numbers, e.g. "Rest 11.6 h ≥ 10". */
  readonly chip: string;
  readonly detail: string;
}

export interface LedgerRowDTO {
  readonly physicianId: string;
  readonly name: string;
  readonly eligible: boolean;
  readonly rank: number | null;
  readonly rules: readonly LedgerRuleDTO[];
  readonly failedRules: readonly string[];
  readonly window: { readonly startMs: number; readonly endMs: number; readonly minutesToOnline: number; readonly effectiveMinutes: number; readonly bindingCap: string } | null;
  readonly value: number | null;
  readonly scopeHospitalIds: readonly string[];
}

export interface TrapDTO {
  readonly physicianId: string;
  readonly name: string | null;
  readonly startMs: number;
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

export interface WhatIfRowDTO {
  readonly needId: string;
  readonly kind: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly startMs: number;
  readonly endMs: number | 'beyond_horizon';
  readonly outcome: 'closed' | 'downgraded' | 'shortened' | 'unchanged' | string;
  readonly detail: string;
  /** Need-minutes before (to the decision-projection end when open-ended). */
  readonly beforeMinutes: number;
  /** Same-kind minutes that remain after; null when only the frozen text is known. */
  readonly remainingMinutes: number | null;
  readonly after: readonly { readonly kind: string; readonly startMs: number; readonly endMs: number | 'beyond_horizon' }[] | null;
}

export interface WhatIfDTO {
  /** recommended: decide()'s what-if; proposed: an in-flight offer; accepted: frozen at acceptance (offer_accepted). */
  readonly source: 'recommended' | 'proposed' | 'accepted' | 'none';
  readonly offerId: string | null;
  readonly physicianId: string | null;
  readonly name: string | null;
  readonly window: { readonly startMs: number; readonly endMs: number } | null;
  readonly rows: readonly WhatIfRowDTO[];
  readonly routableAtStart: readonly { readonly hospitalId: string; readonly atMs: number; readonly count: number }[];
  readonly introduced: readonly { readonly kind: string; readonly hospitalId: string; readonly startMs: number; readonly endMs: number | 'beyond_horizon' }[];
  readonly filledNeedIds: readonly string[];
}

export interface OfferDTO {
  readonly offerId: string;
  readonly slotId: string;
  readonly physicianId: string;
  readonly name: string;
  readonly status: OfferStatus;
  readonly needs: readonly FrozenNeed[];
  readonly window: { readonly startMs: number; readonly endMs: number; readonly minutesToOnline: number; readonly effectiveMinutes: number; readonly bindingCap: string };
  readonly routingScope: readonly string[];
  readonly hospitalNames: readonly string[];
  readonly seededConsultCount: number;
  readonly value: number;
  readonly channel: string;
  readonly message: string;
  readonly trapWhy: readonly string[];
  readonly ledger: readonly FrozenLedgerRow[];
  readonly proposedAtMs: number;
  readonly proposedBy: string;
  readonly approvedAtMs: number | null;
  readonly approvedBy: string | null;
  readonly deliveredAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly msUntilExpiry: number | null;
  readonly allowedActions: Readonly<Record<string, readonly string[]>>;
  readonly outcome: { readonly status: string; readonly atMs: number | null; readonly by: string | null; readonly detail: string } | null;
  readonly coverageEffect: CoverageEffect | null;
  /** Path of the physician's phone view. */
  readonly offerPath: string;
}

export interface EscalationDTO {
  readonly escalationId: string;
  readonly subject: { readonly needId?: string; readonly attentionItemId?: string; readonly consultIds?: readonly string[]; readonly hospitalIds?: readonly string[] };
  readonly headline: string;
  readonly reason: string;
  readonly raisedAtMs: number;
  readonly raisedBy: string;
  readonly authorizedAtMs: number | null;
  readonly authorizedBy: string | null;
  readonly note: string | null;
}

/** A reassignment request (brief "Users and Decision Rights": the coordinator can "Reassign consults"; recorded as "requested in Synapse", D-88). */
export interface ReassignmentDTO {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly fromPhysicianId: string | null;
  readonly toPhysicianId: string;
  readonly requestedAtMs: number;
  readonly requestedBy: string;
  readonly label: string;
  readonly why: string;
}

export interface RecStepDTO {
  readonly kind: string;
  readonly summary: string;
  readonly detail: readonly string[];
  readonly proposer: string;
  readonly approver: string | null;
  readonly acceptor: string | null;
  readonly candidates: readonly { readonly physicianId: string; readonly why: string }[];
  readonly physicianIds: readonly string[];
  readonly hospitalIds: readonly string[];
  readonly consultIds: readonly string[];
}

export interface RecommendationDTO {
  readonly attentionItemId: string;
  readonly headline: string;
  readonly rationale: readonly string[];
  readonly steps: readonly RecStepDTO[];
}

export interface RecommendedOfferDTO {
  readonly physicianId: string;
  readonly name: string;
  readonly window: { readonly startMs: number; readonly endMs: number; readonly minutesToOnline: number; readonly effectiveMinutes: number; readonly bindingCap: string };
  readonly routingScope: readonly string[];
  readonly scopeNames: readonly string[];
  readonly seededConsultCount: number;
  readonly value: number;
  readonly coversNeeds: readonly string[];
  readonly why: readonly string[];
  readonly message: string;
  readonly trap: TrapDTO;
  readonly whatIf: WhatIfDTO;
}

export interface FlagDTO {
  readonly code: string;
  readonly label: string;
  readonly sinceMs: number;
  readonly detail: string;
  readonly because: readonly EvidenceDTO[];
}

export interface PhysicianRowDTO {
  readonly physicianId: string;
  readonly name: string;
  readonly shift: string;
  readonly selfReported: string;
  readonly agent: string;
  readonly derivedState: string;
  readonly derivedBecause: readonly EvidenceDTO[];
  readonly consults: number;
  readonly calls: number;
  readonly open: number;
  readonly minToEnd: string;
  readonly openConsultIds: readonly string[];
  readonly flags: readonly FlagDTO[];
}

export interface ConsultRowDTO {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly type: string;
  readonly stage: string;
  readonly enteredMs: number | null;
  readonly minInStage: number | null;
  readonly minSinceReceived: number | null;
  readonly assigned: string | null;
  readonly standard: { readonly label: string; readonly level: 'ok' | 'warning' | 'critical'; readonly elapsedMin: number; readonly warnAtMs: number; readonly criticalAtMs: number } | null;
}

export interface IntegritySummaryDTO {
  readonly snapshotLabel: string | null;
  readonly snapshotMs: number | null;
  readonly physicians: string;
  readonly consults: string;
  readonly diffs: number;
  readonly naive: { readonly physicians: string; readonly consults: string; readonly diffs: number };
  readonly duplicates: number;
  readonly lateEvents: number;
  readonly warnings: number;
  readonly eventCount: number;
  readonly appendedCount: number;
}

export interface InjectSampleDTO {
  readonly surgingHospitalId: string | null;
  readonly surgingHospitalName: string | null;
  readonly nextConsultId: string;
  readonly nextEventIds: readonly [string, string];
}

export interface OfferContextDTO {
  readonly source: WhatIfDTO['source'];
  readonly offerId: string | null;
  readonly trap: TrapDTO | null;
  readonly whatIf: WhatIfDTO;
}

export interface DatasetInfoDTO {
  readonly key: string;
  readonly label: string;
  readonly source: 'raw' | 'upload';
  readonly snapshotLabel: string | null;
  readonly eventCount: number;
  readonly previousLabel: string | null;
  readonly store: string;
}

export interface ViewDTO {
  readonly bootId: string;
  readonly dataset: DatasetInfoDTO;
  readonly version: number;
  readonly logSeq: number;
  readonly clock: ClockDTO;
  readonly lastEventAtMs: number | null;
  /** Present when the sim clock is past the last ingested Sevaro event. */
  readonly noNewEventsSince?: number;
  readonly integrity: IntegritySummaryDTO;
  readonly attention: readonly AttentionDTO[];
  readonly coverage: CoverageGridDTO;
  readonly demand: readonly DemandChipDTO[];
  readonly needs: readonly Need[];
  readonly recommendation: RecommendationDTO | null;
  readonly ledger: readonly LedgerRowDTO[];
  readonly recommendedOffer: RecommendedOfferDTO | null;
  /** Trap + what-if for the tabs: the latest offer if any, else the recommended one. */
  readonly offerContext: OfferContextDTO;
  readonly offers: readonly OfferDTO[];
  /** Who to offer next (engine recommendNext once an offer was declined, expired or rejected; OQ-43). */
  readonly nextOffer: {
    readonly physicianId: string | null;
    readonly name: string | null;
    readonly why: readonly string[];
    readonly spent: readonly { readonly offerId: string; readonly physicianId: string; readonly name: string; readonly status: string }[];
    readonly escalationSuggested: boolean;
  };
  readonly escalations: readonly EscalationDTO[];
  /** Reassignment requests from the action log (D-88; exported with every other action at GET /api/audit/actions.csv). */
  readonly reassignments: readonly ReassignmentDTO[];
  readonly physicians: readonly PhysicianRowDTO[];
  readonly consults: readonly ConsultRowDTO[];
  readonly sample: InjectSampleDTO;
  /** QR (SVG markup) per delivered offer, for the current request's origin. */
  readonly qr?: Readonly<Record<string, { readonly url: string; readonly svg: string }>>;
}

/** Physician phone view (GET /api/offers/:id): only what the brief allows in a notification. */
export interface PublicOfferDTO {
  readonly offerId: string;
  readonly physicianId: string;
  readonly status: OfferStatus;
  readonly nowMs: number;
  readonly clockMode: ClockMode;
  readonly clockSpeed: ClockSpeed;
  /** The delivered message lines (null until approved and delivered). */
  readonly messageLines: readonly string[] | null;
  readonly hospitals: readonly string[];
  readonly startMs: number;
  readonly endMs: number;
  readonly expiresAtMs: number | null;
  readonly msUntilExpiry: number | null;
  readonly canRespond: boolean;
  /** Plain-English state for terminal or not-yet-sent offers. */
  readonly headline: string;
  readonly reason: string | null;
}

export interface CommandResponse {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly replayed?: boolean;
  readonly emitted?: readonly { readonly type: string; readonly seq: number; readonly actionId: string }[];
  readonly seq?: number;
  readonly coverage?: CoverageEffect | null;
}
