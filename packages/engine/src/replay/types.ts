import type { ConsultStage, ConsultType, EpochMs, EventType, SelfReportedStatus } from '../types';
import type { DerivedStateLabel, RuleCode } from './rules';

/**
 * Replay state. Physician activity and consult lifecycle are separate models
 * (brief "Important Data Model Concepts": "Physician state and consult state
 * are separate").
 */

export type ReplayMode = 'correct' | 'naive';

/** Pointer to the event that justifies a derived value. */
export interface EventRef {
  readonly eventId: string;
  readonly eventTimeMs: EpochMs;
  readonly eventType: EventType;
}

/** A derived value plus the events and rule that produced it. */
export interface Provenanced<T> {
  readonly value: T;
  readonly because: readonly EventRef[];
  readonly rule: RuleCode;
}

export interface ActiveCall {
  readonly direction: 'incoming' | 'outgoing';
  readonly consultId: string | null;
  readonly hospitalId: string | null;
  readonly startedMs: EpochMs;
  readonly eventId: string;
}

export interface ActiveVideo {
  readonly consultId: string | null;
  readonly hospitalId: string | null;
  readonly startedMs: EpochMs;
  readonly eventId: string;
}

export interface Ringing {
  readonly consultId: string | null;
  readonly hospitalId: string | null;
  readonly sinceMs: EpochMs;
  readonly eventId: string;
}

export type PhysicianFlag =
  | Provenanced<{ readonly code: 'EXTERNAL_VIDEO_SUSPECTED'; readonly sinceMs: EpochMs }>
  | Provenanced<{ readonly code: 'AGENT_OFFLINE_UNVERIFIED'; readonly sinceMs: EpochMs }>
  | Provenanced<{ readonly code: 'TEMP_UNAVAILABLE_WITH_ASSIGNED'; readonly sinceMs: EpochMs; readonly consultIds: readonly string[] }>
  | Provenanced<{ readonly code: 'RINGING_UNANSWERED'; readonly sinceMs: EpochMs; readonly consultId: string | null; readonly seconds: number }>
  | Provenanced<{ readonly code: 'IN_MEETING_INTERRUPTIBLE'; readonly sinceMs: EpochMs; readonly cameraActive: boolean }>;

export interface PhysicianState {
  readonly physicianId: string;
  readonly name: string | null;
  /** True when listed in physicians_on_shift.csv; others are tracked because they appear in events. */
  readonly onRoster: boolean;
  /** From physicians_on_shift.csv (ET wall-clock on the scenario date, OQ-13); null if not on the roster. */
  readonly shift: { readonly startMs: EpochMs; readonly endMs: EpochMs } | null;
  readonly shiftStartedMs: EpochMs | null;
  readonly selfStatus: Provenanced<SelfReportedStatus | null>;
  readonly agent: { readonly online: boolean; readonly sinceMs: EpochMs | null; readonly because: readonly EventRef[] };
  /** active is null while the agent is offline (brief: "offline means camera state is unknown"). */
  readonly camera: { readonly active: boolean | null; readonly sinceMs: EpochMs | null; readonly because: readonly EventRef[] };
  readonly activeCalls: readonly ActiveCall[];
  readonly activeVideo: ActiveVideo | null;
  readonly ringing: Ringing | null;
  readonly lastCallEndedMs: EpochMs | null;
  readonly lastVideoEndedMs: EpochMs | null;
  readonly consultsThisShift: number;
  readonly callsThisShift: number;
  /** Latest incoming_call_started; brief routing rule 4 tie-break ("whoever answered least recently"). */
  readonly lastAnsweredMs: EpochMs | null;
  readonly openConsultIds: readonly string[];
  readonly derivedState: Provenanced<DerivedStateLabel>;
  readonly flags: readonly PhysicianFlag[];
}

export interface StageEntry {
  readonly stage: ConsultStage;
  readonly enteredMs: EpochMs;
  readonly eventId: string;
}

export interface ConsultState {
  readonly consultId: string;
  readonly hospitalId: string | null;
  readonly hospitalName: string | null;
  readonly consultType: ConsultType | null;
  readonly phoneOnly: boolean;
  readonly receivedMs: EpochMs | null;
  readonly stage: ConsultStage | null;
  readonly stageEnteredMs: EpochMs | null;
  readonly stageHistory: readonly StageEntry[];
  readonly assignedPhysicianId: string | null;
  readonly assignmentHistory: readonly { readonly physicianId: string; readonly atMs: EpochMs; readonly eventId: string }[];
  /** First incoming or outgoing call start. */
  readonly contactedMs: EpochMs | null;
  readonly routingFailures: readonly { readonly atMs: EpochMs; readonly eventId: string }[];
  readonly ringingTo: { readonly physicianId: string; readonly sinceMs: EpochMs } | null;
  /** OQ-18: later of last video end / last call end, fixed when the consult first enters Note Pending or Documentation. */
  readonly noteClockStartMs: EpochMs | null;
  readonly signedMs: EpochMs | null;
  readonly open: boolean;
  /** Event ids applied to this consult, in application order. */
  readonly events: readonly string[];
}

export interface DuplicateRecord {
  readonly kept: { readonly eventId: string; readonly line: number; readonly ingestedAtMs: EpochMs };
  readonly dropped: { readonly eventId: string; readonly line: number; readonly ingestedAtMs: EpochMs };
  readonly reason: string;
}

export interface LateEventRecord {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly eventTimeMs: EpochMs;
  readonly ingestedAtMs: EpochMs;
  readonly lagMs: number;
}

export interface NetworkState {
  readonly asOfMs: EpochMs;
  readonly mode: ReplayMode;
  /** ET calendar date used to anchor date-less clock values (OQ-13). */
  readonly scenarioDate: string;
  readonly physicians: Readonly<Record<string, PhysicianState>>;
  readonly consults: Readonly<Record<string, ConsultState>>;
  readonly integrity: {
    readonly duplicates: readonly DuplicateRecord[];
    readonly lateEvents: readonly LateEventRecord[];
    readonly warnings: readonly string[];
    readonly appliedCount: number;
    readonly ignoredCount: number;
  };
}
