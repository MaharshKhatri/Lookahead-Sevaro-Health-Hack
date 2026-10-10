import { ET_ZONE } from './time';
import type { ConsultStage, EventType, SelfReportedStatus } from './types';

/**
 * Default interpretations where the brief (docs/brief_c2.md) is silent or
 * ambiguous. Each constant names its docs/OPEN_QUESTIONS.md entry and is
 * logged in docs/DECISIONS.md (CLAUDE.md rule 1). Rules implemented in later
 * sessions must read these constants instead of re-deciding.
 */

/** OQ-01: coverage_requirements blocks are ET wall-clock, start-inclusive, end-exclusive; "22:00-07:00" wraps midnight. */
export const COVERAGE_BLOCK_BOUNDARY = 'start_inclusive_end_exclusive' as const;

/**
 * OQ-02: "available" for coverage = on shift + credentialed at the hospital +
 * self-reported status not excluded below. A physician busy on a call/video
 * still counts (busy is momentary; coverage is staffing). Agent-offline
 * physicians count but are flagged (brief: "Agent offline ... Surface the risk").
 */
export const COVERAGE_EXCLUDED_STATUSES: readonly SelfReportedStatus[] = ['Temporarily Unavailable'];
export const COVERAGE_COUNTS_BUSY_PHYSICIANS = true;
export const COVERAGE_COUNTS_AGENT_OFFLINE = true;

/** OQ-03: baseline_hourly_volume hour buckets are ET (header: hour_start_et). */
export const BASELINE_HOUR_ZONE = ET_ZONE;

/**
 * OQ-04: two rows are the same event when event_id matches and every column
 * except ingested_at is identical. Keep the earliest-ingested copy. Same
 * event_id with different content is a conflict: keep both, raise a warning.
 */
export const DUPLICATE_EVENT_KEY = 'event_id_and_payload' as const;

/** OQ-05: a stage is at warning/critical when elapsed >= threshold (exact ms; identical to floored minutes >= threshold). */
export const BREACH_COMPARISON = 'gte' as const;

/** OQ-06: an open note (Documentation) does not make a physician busy for routing. */
export const DOCUMENTATION_COUNTS_AS_BUSY = false;

/** OQ-07: the 2-minute "ended a call" cooldown applies to hospital calls only, not video. */
export const CALL_COOLDOWN_INCLUDES_VIDEO = false;

/** OQ-08: the 2-hour minimum is measured after subtracting est_minutes_to_online from the offered window. */
export const OFFER_TIME_TO_ONLINE_COUNTS_AGAINST_MINIMUM = true;

/** OQ-09: offers-per-week come from our own offer log (ISO week starting Monday 00:00 ET), starting at 0. */
export const WEEKLY_OFFER_COUNT_SOURCE = 'offer_log_iso_week_et' as const;

/**
 * OQ-10: a shift (or a split-shift offer) that starts in [06:00, 18:00) ET is a
 * day shift; otherwise night. Used for the routing low-volume threshold
 * because physicians_on_shift.csv has no role column.
 */
export const DAY_SHIFT_START_WINDOW_ET = { startSecondOfDay: 6 * 3600, endSecondOfDay: 18 * 3600 } as const;

/** OQ-11: snapshot consults_this_shift / calls_this_shift count these event types (ringing is not a call). */
export const CONSULT_COUNT_EVENT_TYPES: readonly EventType[] = ['physician_assigned'];
export const CALL_COUNT_EVENT_TYPES: readonly EventType[] = ['incoming_call_started', 'outgoing_call_started'];
/** OQ-11: "this shift" counters restart at the physician's shift_started event. */
export const SHIFT_COUNTERS_RESET_ON_SHIFT_STARTED = true;

/** OQ-12: replay always orders by event_time; the UI flags an event as "late" when ingested_at - event_time exceeds this. */
export const LATE_EVENT_FLAG_LAG_MS = 60_000;

/** OQ-13: date-less clock values in the files are ET, on the ET date of the latest event_time. */
export const SNAPSHOT_CLOCK_ZONE = ET_ZONE;

/** OQ-14: self-reported status and consult type exist only in the description text. */
export const STATUS_DESCRIPTION_PREFIX = 'Self-reported status: ';
export const CONSULT_TYPE_DESCRIPTION_SUFFIX = ' consult request received';

/** OQ-15: derived-state label when several signals are active at once (first match wins). */
export const DERIVED_STATE_PRECEDENCE = [
  'incoming_call',
  'outgoing_call',
  'video',
  'camera_without_synapse',
  'temporarily_unavailable',
  'documentation',
  'in_meeting',
  'available',
] as const;

/** OQ-16: after agent_heartbeat_lost the agent is offline until that physician's next camera_active/camera_inactive. */
export const AGENT_BACK_ONLINE_ON_CAMERA_EVENT = true;

/** OQ-17: a ringing phone lasts until that physician's next call event; no timeout is assumed. */
export const RINGING_TIMEOUT_MS: number | null = null;

/**
 * OQ-18: brief "Operational Standards" times Note Pending + Documentation "from end of video or call":
 * the anchor is the later of the last video_ended and the last call end. A call end whose description
 * contains this marker moves a phone-only consult to Note Pending.
 */
export const NOTE_TIMER_ANCHOR = 'latest_video_or_call_end' as const;
export const PHONE_ONLY_DESCRIPTION_MARKER = 'phone-only';

/**
 * OQ-19: demand spike = consults received in (t - 60 min, t] is strictly
 * greater than p90_consults for the ET hour containing t. A hospital in spike
 * at `now` keeps the +1 requirement for the whole projection horizon.
 */
export const DEMAND_SPIKE_WINDOW_MS = 60 * 60_000;
export const DEMAND_SPIKE_COMPARISON = 'gt' as const;
export const DEMAND_SPIKE_PROJECTION = 'hold_from_now_through_horizon' as const;

/** OQ-20: hours_worked_last_7d is taken as-is at load time; offered hours are added to it. */
export const HOURS_7D_AS_OF = 'roster_value_at_load' as const;

/** OQ-21: an offer may end exactly when the physician's next shift starts (intervals are half-open). */
export const OFFER_MAY_END_AT_NEXT_SHIFT_START = true;

/** OQ-22: "open notes" = assigned consults in these stages; "within 60 min" includes exactly 60. */
export const OPEN_NOTE_STAGES: readonly ConsultStage[] = ['Note Pending', 'Documentation'];
export const OPEN_NOTES_WINDOW_INCLUSIVE = true;

/**
 * OQ-23: a physician with an assigned consult that has had no call yet is
 * treated as having a phone ringing for it (brief routing rule 2), so routing
 * skips them until that first call starts.
 */
export const PENDING_FIRST_CONTACT_COUNTS_AS_RINGING = true;

/**
 * OQ-25: an event that maps to the consult's current stage (e.g. a second
 * imaging_requested) keeps the original stage entry time; an event that maps
 * to an earlier lifecycle stage is applied and raises an integrity warning.
 */
export const STAGE_REENTRY_KEEPS_ENTRY_TIME = true;
export const STAGE_REGRESSION = 'apply_with_warning' as const;

/** OQ-26: inside routing rule 3's low-volume tier, order like rule 4 (fewest consults, then least recently answered, never-answered first), then physician id. */
export const LOW_VOLUME_TIER_ORDER = 'fewest_consults_then_least_recent_answer' as const;

/**
 * OQ-27: off-shift roster physicians with a next_shift_start are on shift from
 * then for this many hours (the roster gives no end). They count in staffed
 * capacity (brief roster note: "A scheduled night shift is not a split-shift
 * offer") and satisfy routing rule 1 from their start, unverified until they
 * produce presence signals.
 */
export const SCHEDULED_SHIFT_HOURS = 12;
export const SCHEDULED_ARRIVALS_COUNT_AS_ON_SHIFT = true;

/** OQ-28: in a projection, each physician's current self-reported status (e.g. Temporarily Unavailable) persists. */
export const PROJECTION_HOLDS_CURRENT_STATUS = true;

/** OQ-03 addendum: baseline rows used on Monday-Friday ET; on other days there is no baseline and no spike is evaluated. */
export const BASELINE_WEEKDAY_DOW_TYPE = 'weekday';

/** Coverage projection horizon and grid (brief "What Teams Must Demonstrate" #4: "at least 90 minutes"). */
export const PROJECTION_HORIZON_MIN = 120;
export const PROJECTION_STEP_MIN = 5;

/** Attention list: a standard that crosses its next threshold within this window is IMMINENT_BREACH. */
export const IMMINENT_WINDOW_MIN = 15;

/**
 * Attention ranking weights (brief: "Detect and rank what needs attention, and
 * explain why each item was flagged"). score = sum of the factors below; the UI
 * shows the per-item breakdown. Ties break by item id.
 */
export const ATTENTION_WEIGHTS = {
  kind: {
    ROUTING_DEADLOCK: 60,
    STANDARD_BREACH: 40,
    COVERAGE_GAP: 35,
    IMMINENT_BREACH: 20,
    OPEN_NOTES_NEAR_SHIFT_END: 20,
    DEMAND_SPIKE: 15,
    SIGNAL_CONFLICT: 10,
  },
  /** Level of the breach or deadlock now (a deadlock is always critical; imminent items use the level they will reach). */
  level: { critical: 30, warning: 10 },
  strokeAtRisk: 25,
  /** Full points when impact is now, falling linearly to 0 at PROJECTION_HORIZON_MIN. */
  urgencyMax: 20,
  /** Per minute past the threshold already crossed, capped. */
  overduePerMinute: 0.5,
  overdueCap: 15,
  /** A warning breach that turns critical within IMMINENT_WINDOW_MIN. */
  escalatesSoon: 8,
  shortfallPerPhysician: 10,
  spikeExcessPerConsult: 5,
  spikeExcessCap: 20,
  openNotePerNote: 5,
  signal: {
    EXTERNAL_VIDEO_SUSPECTED: 15,
    AGENT_OFFLINE_UNVERIFIED: 10,
    TEMP_UNAVAILABLE_WITH_ASSIGNED: 20,
    RINGING_UNANSWERED: 15,
  },
} as const;

/** Severity from score (lower bounds, checked in order). */
export const ATTENTION_SEVERITY_BANDS = [
  { severity: 'critical', minScore: 110 },
  { severity: 'high', minScore: 80 },
  { severity: 'medium', minScore: 50 },
  { severity: 'low', minScore: Number.NEGATIVE_INFINITY },
] as const;

/**
 * OQ-29: a scheduled arrival (or accepted offer) is EXPECTED until a shift_started
 * for that physician is known and dated at/after the scheduled start minus this
 * tolerance; then CONFIRMED. A hospital interval is AT_RISK when its requirement
 * is met only thanks to expected arrivals and the margin is at most AT_RISK_MAX_MARGIN.
 */
export const ARRIVAL_CONFIRMATION_EARLY_TOLERANCE_MIN = 0;
export const AT_RISK_MAX_MARGIN = 0;

/**
 * OQ-30: needs that make a hospital one of "the hospitals with the gap" for
 * split-shift eligibility. AT_RISK (requirement met by an unconfirmed scheduled
 * arrival) is advisory: confirm the arrival, do not offer a split shift for it.
 */
export const ELIGIBILITY_NEED_KINDS: readonly ('DEADLOCK_NOW' | 'HARD_GAP' | 'AT_RISK')[] = ['DEADLOCK_NOW', 'HARD_GAP'];

/**
 * OQ-31: needs must start within the detection horizon (PROJECTION_HORIZON_MIN),
 * but their end is traced in a longer decision projection so an offer window
 * (up to MAX_OFFER_HOURS after time to come online) is not cut at 120 min.
 */
export const DECISION_HORIZON_MIN = 300;

/** OQ-32: a DEADLOCK_NOW need lasts until the first arrival/offer credentialed (and in scope) at that hospital starts; otherwise this long. */
export const DEADLOCK_DEFAULT_WINDOW_MIN = 60;

/** OQ-33: need severity by kind, and the per-minute weights used to value an offer's overlap with needs. */
export const NEED_KIND_SEVERITY = { DEADLOCK_NOW: 'critical', HARD_GAP: 'high', AT_RISK: 'medium' } as const;
export const NEED_VALUE_WEIGHTS = { DEADLOCK_NOW: 3, HARD_GAP: 2, AT_RISK: 1 } as const;

/** OQ-33: longest split-shift offer we construct, in hours (the brief sets only a 2-h minimum). */
export const MAX_OFFER_HOURS = 4;

/** OQ-34: rank eligible physicians by value desc, then shorter time to come online, then fewer declines in 30 days, then id. */
export const ELIGIBLE_RANK_ORDER = 'value_then_time_to_online_then_declines' as const;

/**
 * OQ-35: split-shift trap mitigation. SCOPE limits the joiner's routing (and
 * counted coverage) to the offer's need hospitals for the offer window; SEED
 * starts their consult count at the median consults-this-shift of on-shift
 * physicians credentialed at those hospitals (even count: floor of the two
 * middle values' mean). Default: both.
 */
export const TRAP_MITIGATION: 'scope' | 'seed' | 'scope_and_seed' = 'scope_and_seed';
export const TRAP_SEED_STATISTIC = 'median_floor' as const;

/** Design choice (DECISIONS D-50): interventions are generated for this many top attention items, plus every need. */
export const INTERVENTION_TOP_ITEMS = 10;
