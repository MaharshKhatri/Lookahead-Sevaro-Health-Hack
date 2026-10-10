/**
 * Domain types for Lookahead. CSV column names are mapped to these camelCase
 * fields exactly once, in src/data/ (CLAUDE.md rule 2).
 *
 * Instants are epoch milliseconds UTC (CLAUDE.md rule 4). Wall-clock values
 * that the files give without a date or offset (e.g. shift times, coverage
 * blocks) are kept as ClockTime / TimeBlock and converted to instants later
 * with an explicit zone.
 */

/** Epoch milliseconds, UTC. */
export type EpochMs = number;

/**
 * Event types, verbatim from brief "Synthetic Dataset" -> "Event types".
 * The brief's slash forms (incoming_call_started/ended, outgoing_call_started/ended,
 * video_started/ended, camera_active/inactive) are expanded.
 */
export const EVENT_TYPES = [
  'consult_received',
  'consult_triaged',
  'physician_assigned',
  'incoming_call_ringing',
  'incoming_call_started',
  'incoming_call_ended',
  'outgoing_call_started',
  'outgoing_call_ended',
  'imaging_requested',
  'imaging_returned',
  'video_started',
  'video_ended',
  'note_started',
  'note_signed',
  'routing_attempt_failed',
  'physician_status_changed',
  'camera_active',
  'camera_inactive',
  'agent_heartbeat_lost',
  'shift_started',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Brief "Consult lifecycle": Received -> Triaged -> Assigned -> Provider Contacted ->
 * CT/CTA or Imaging Pending -> Imaging Review -> Video Consult In Progress ->
 * Note Pending -> Documentation -> Signed Off.
 */
export const CONSULT_STAGES = [
  'Received',
  'Triaged',
  'Assigned',
  'Provider Contacted',
  'CT/CTA or Imaging Pending',
  'Imaging Review',
  'Video Consult In Progress',
  'Note Pending',
  'Documentation',
  'Signed Off',
] as const;
export type ConsultStage = (typeof CONSULT_STAGES)[number];

/** Brief "Availability is inferred, not reported": self-reported status values. */
export const SELF_REPORTED_STATUSES = ['Available', 'In Meeting', 'Temporarily Unavailable'] as const;
export type SelfReportedStatus = (typeof SELF_REPORTED_STATUSES)[number];

/** Brief "Operational Standards", "Applies to" column (the brief's "All" means both). */
export const CONSULT_TYPES = ['Stroke', 'General Neuro'] as const;
export type ConsultType = (typeof CONSULT_TYPES)[number];

/** A wall-clock time of day with no date or offset, as written in the file. */
export interface ClockTime {
  readonly raw: string;
  /** Seconds since local midnight, 0..86399. */
  readonly secondOfDay: number;
}

/** A wall-clock range such as "22:00-07:00". End is after start unless it wraps midnight. */
export interface TimeBlock {
  readonly raw: string;
  readonly start: ClockTime;
  readonly end: ClockTime;
  readonly wrapsMidnight: boolean;
}

/** Position of a row in its source file. */
export interface RowSource {
  /** 0-based index among data rows, in file order. */
  readonly rowIndex: number;
  /** 1-based line number in the source file (header is line 1). */
  readonly line: number;
}

/** event_stream.csv. File order is arrival order (brief: "Sorted by ingested_at"). */
export interface RawEvent extends RowSource {
  readonly eventId: string;
  readonly eventTime: EpochMs;
  readonly eventTimeRaw: string;
  readonly ingestedAt: EpochMs;
  readonly ingestedAtRaw: string;
  readonly consultId: string | null;
  readonly eventType: EventType;
  readonly physicianId: string | null;
  readonly hospitalId: string | null;
  readonly description: string;
}

/** hospitals.csv */
export interface Hospital extends RowSource {
  readonly hospitalId: string;
  readonly hospitalName: string;
  /** Validated IANA zone name. */
  readonly localTimezone: string;
  readonly coverageTier: string;
}

/** physicians_on_shift.csv. Shift times are ET wall-clock (column suffix _et). */
export interface OnShiftPhysician extends RowSource {
  readonly physicianId: string;
  readonly name: string;
  readonly shiftStartEt: ClockTime;
  readonly shiftEndEt: ClockTime;
  /** Kept verbatim; the reference file holds "n/a (on shift)" for every row. */
  readonly splitShiftOptIn: string;
}

/** physicians_off_shift_roster.csv */
export interface OffShiftPhysician extends RowSource {
  readonly physicianId: string;
  readonly name: string;
  readonly role: string;
  readonly splitShiftOptIn: boolean;
  readonly lastShiftEnd: EpochMs;
  readonly lastShiftEndRaw: string;
  readonly nextShiftStart: EpochMs;
  readonly nextShiftStartRaw: string;
  readonly hoursWorkedLast7d: number;
  readonly estMinutesToOnline: number;
  readonly preferredChannel: string;
  readonly offersDeclinedLast30d: number;
}

/** credentialing_matrix.csv: one row per physician, one Y/blank column per hospital. */
export interface CredentialRow extends RowSource {
  readonly physicianId: string;
  readonly name: string;
  /** Hospital IDs (column headers) marked "Y", in header order. */
  readonly credentialedHospitalIds: readonly string[];
}

/** baseline_hourly_volume.csv. Hour is ET wall-clock (column hour_start_et). */
export interface BaselineHour extends RowSource {
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly dowType: string;
  readonly hourStartEt: ClockTime;
  readonly meanConsults: number;
  readonly p90Consults: number;
  readonly weeksSampled: number;
}

/** coverage_requirements.csv. Block is ET wall-clock (column time_block_et). */
export interface CoverageRequirement extends RowSource {
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly timeBlockEt: TimeBlock;
  readonly minAvailableCredentialedPhysicians: number;
}

/** snapshot_physicians_<label>.csv: reference state the replay must reproduce. */
export interface SnapshotPhysicianRow extends RowSource {
  readonly physicianId: string;
  readonly name: string;
  readonly shiftEt: TimeBlock;
  readonly selfReportedStatus: SelfReportedStatus;
  readonly desktopAgent: string;
  readonly derivedState: string;
  readonly consultsThisShift: number;
  readonly callsThisShift: number;
  readonly openConsults: number;
  readonly minutesToShiftEnd: number;
}

/** snapshot_open_consults_<label>.csv */
export interface SnapshotConsultRow extends RowSource {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  /** null where the file says "Unassigned". */
  readonly physicianId: string | null;
  readonly consultType: ConsultType;
  readonly currentStage: ConsultStage;
  /** Clock time only, no date or offset in the file. */
  readonly stageEnteredAt: ClockTime;
  readonly minutesInStage: number;
  readonly minutesSinceReceived: number;
}

export interface Snapshot {
  /** Suffix of the snapshot file names, e.g. "1820" for snapshot_*_1820.csv. */
  readonly label: string;
  readonly physicians: readonly SnapshotPhysicianRow[];
  readonly consults: readonly SnapshotConsultRow[];
}

export interface DatasetFileNames {
  readonly events: string;
  readonly hospitals: string;
  readonly physiciansOnShift: string;
  readonly offShiftRoster: string;
  readonly credentials: string;
  readonly baselineHourly: string;
  readonly coverageRequirements: string;
  readonly snapshotPhysicians: string | null;
  readonly snapshotConsults: string | null;
}

export interface Dataset {
  readonly files: DatasetFileNames;
  readonly events: readonly RawEvent[];
  readonly hospitals: readonly Hospital[];
  readonly physiciansOnShift: readonly OnShiftPhysician[];
  readonly offShiftRoster: readonly OffShiftPhysician[];
  readonly credentials: readonly CredentialRow[];
  /** Hospital ID columns of credentialing_matrix.csv, in header order. */
  readonly credentialHospitalIds: readonly string[];
  readonly baselineHourly: readonly BaselineHour[];
  readonly coverageRequirements: readonly CoverageRequirement[];
  readonly snapshot: Snapshot | null;
  /** Non-fatal findings. Rows are never dropped; anything unparseable throws instead. */
  readonly warnings: readonly string[];
}
