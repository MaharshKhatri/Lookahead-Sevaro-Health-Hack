/**
 * Rule codes attached to every explainable derived value (provenance). Each
 * code names the brief section (docs/brief_c2.md) or open question it encodes,
 * so the UI can show "why" without re-deriving anything.
 */
export const RULES = {
  // Physician signals: brief "Availability is inferred, not reported" (signal table).
  STATUS_SELF_REPORTED: { cites: 'Availability is inferred, not reported: Self-reported status; OQ-14 (value parsed from description)' },
  AGENT_HEARTBEAT: { cites: 'Availability is inferred, not reported: Agent heartbeat; OQ-16 (back online on next camera event)' },
  CAMERA_SIGNAL: { cites: 'Availability is inferred, not reported: Camera activity ("offline means camera state is unknown")' },

  // Derived state labels, first match wins: OQ-15 / policy DERIVED_STATE_PRECEDENCE.
  DERIVED_INCOMING_CALL: { cites: 'Availability: "On a Synapse call or video session: busy"; OQ-15' },
  DERIVED_OUTGOING_CALL: { cites: 'Availability: "On a Synapse call or video session: busy"; OQ-15' },
  DERIVED_VIDEO: { cites: 'Availability: "On a Synapse call or video session: busy"; OQ-15' },
  DERIVED_CAMERA_NO_SYNAPSE: { cites: 'Availability: "Camera active with no Synapse video session and status not In Meeting ... Treat as busy and flag it"; OQ-15' },
  DERIVED_TEMP_UNAVAILABLE: { cites: 'Availability: Self-reported status "Temporarily Unavailable"; OQ-15' },
  DERIVED_DOCUMENTATION: { cites: 'Consult lifecycle: "Documentation means the note is being written"; OQ-06, OQ-15' },
  DERIVED_IN_MEETING: { cites: 'Availability: "Camera active with status In Meeting: available (internal meetings are interruptible)"; OQ-15' },
  DERIVED_AVAILABLE: { cites: 'Availability: no busy signal active; OQ-15' },

  // Physician flags.
  FLAG_EXTERNAL_VIDEO: { cites: 'Availability: "Camera active with no Synapse video session and status not In Meeting: probably on an external video platform. Treat as busy and flag it."' },
  FLAG_AGENT_OFFLINE: { cites: 'Availability: "Agent offline: routing assumes the physician is available, but this is unverified. Surface the risk."' },
  FLAG_TEMP_UNAVAILABLE_ASSIGNED: { cites: 'Operational Situations: "A physician becomes temporarily unavailable while a stroke consult is still assigned to them."' },
  FLAG_RINGING_UNANSWERED: { cites: 'How Calls Reach Physicians rule 2: "anyone whose phone is already ringing for another call"; OQ-17' },
  FLAG_IN_MEETING_INTERRUPTIBLE: { cites: 'Availability: "Camera active with status In Meeting: available (internal meetings are interruptible)."' },

  // Routing: brief "How Calls Reach Physicians (Synthetic Routing Rules)"; OQ-24(b).
  ROUTE_ON_SHIFT: { cites: 'Routing rule 1: "Eligible physicians are on shift"; scheduled arrivals per OQ-27' },
  ROUTE_CREDENTIALED: { cites: 'Routing rule 1: "... and credentialed at the calling hospital"' },
  ROUTE_NOT_ON_CALL: { cites: 'Routing rule 2: "Remove anyone busy"; Availability: "On a Synapse call or video session: busy"' },
  ROUTE_NOT_ON_VIDEO: { cites: 'Routing rule 2: "Remove anyone busy"; Availability: "On a Synapse call or video session: busy"' },
  ROUTE_NOT_EXTERNAL_VIDEO: { cites: 'Routing rule 2 + Availability: camera active with no Synapse session and not In Meeting -> "Treat as busy"' },
  ROUTE_NOT_TEMP_UNAVAILABLE: { cites: 'Routing rule 2 + Availability: self-reported "Temporarily Unavailable"' },
  ROUTE_PHONE_NOT_RINGING: { cites: 'Routing rule 2: "anyone whose phone is already ringing for another call"; OQ-17' },
  ROUTE_NO_PENDING_FIRST_CONTACT: { cites: 'Routing rule 2 (ringing) as inferred from data: assigned consult not yet contacted; OQ-23' },
  ROUTE_CALL_COOLDOWN: { cites: 'Routing rule 2: "anyone who ended a call less than 2 minutes ago"; OQ-07 (calls only)' },
  ROUTE_DOCUMENTING_ALLOWED: { cites: 'OQ-06: documenting does not make a physician busy for routing' },
  ROUTE_IN_MEETING_ALLOWED: { cites: 'Availability: "Camera active with status In Meeting: available (internal meetings are interruptible)"' },
  ROUTE_AGENT_VERIFIED: { cites: 'Availability: "Agent offline: routing assumes the physician is available, but this is unverified. Surface the risk."' },
  ROUTE_LOW_VOLUME_PRIORITY: { cites: 'Routing rule 3: low volume this shift (6 or fewer on days, 4 or fewer on nights) gets priority; OQ-10, OQ-26' },
  ROUTE_FEWEST_CONSULTS: { cites: 'Routing rule 4: fewest consults this shift; ties to whoever answered least recently; OQ-26' },
  ROUTE_NO_ONE_ELIGIBLE: { cites: 'Routing rule 5: "If nobody is eligible, the routing attempt fails"' },

  // Operational Standards (brief table), OQ-05 comparison, OQ-18 note clock, OQ-22 open notes.
  STANDARD_TIME_IN_STAGE: { cites: 'Operational Standards table; OQ-05 (>= on exact elapsed)' },
  STANDARD_NOTE_CLOCK: { cites: 'Operational Standards: "Note Pending + Documentation, from end of video or call"; OQ-18' },
  STANDARD_OPEN_NOTES_NEAR_SHIFT_END: { cites: 'Operational Standards: "Open notes within 60 min of the physician\'s shift end" (Any / 2 or more); OQ-22' },

  // Coverage and demand: brief "Coverage and Split-Shift Eligibility"; OQ-01, OQ-02, OQ-19, OQ-24(a).
  DEMAND_SPIKE_TRAILING_60: { cites: 'Coverage: "A demand spike (trailing 60-minute consults above the hospital\'s p90 baseline for that hour) raises the requirement by one"; OQ-03, OQ-19' },
  COVERAGE_STAFFED_CAPACITY: { cites: 'Coverage: "minimum number of available, credentialed physicians per time block"; OQ-02, OQ-24(a), OQ-28' },
  COVERAGE_SHIFT_END: { cites: 'Coverage: gap "at a projected time (for example, when shifts end at 19:00)"; OQ-21' },
  COVERAGE_SCHEDULED_ARRIVAL: { cites: 'Off-shift roster note: "A scheduled night shift is not a split-shift offer"; OQ-27' },
  COVERAGE_BLOCK_CHANGE: { cites: 'coverage_requirements.csv time blocks; OQ-01' },
  COVERAGE_ARRIVAL_CONFIRMATION: { cites: 'Scheduled arrivals are expected until a shift_started is known; OQ-27, OQ-29' },

  // Needs (Decide layer inputs): brief "Problem to Solve" (Detect -> Decide), OQ-29..OQ-32.
  NEED_DEADLOCK_NOW: { cites: 'Routing rule 5 now: open consult with no routable physician; OQ-24(b), OQ-32' },
  NEED_HARD_GAP: { cites: 'Coverage: "A gap exists when that number is not met, either now or at a projected time"; OQ-29' },
  NEED_AT_RISK: { cites: 'Coverage met only via an unconfirmed scheduled arrival with zero margin; OQ-29 (advisory, OQ-30)' },

  // Split-shift eligibility: brief "Coverage and Split-Shift Eligibility" bullets 1-6.
  ELIG_OPT_IN: { cites: 'Eligibility: "They have opted in to split-shift offers."' },
  ELIG_CREDENTIALED_AT_GAP: { cites: 'Eligibility: "They are credentialed at one or more of the hospitals with the gap. Being credentialed elsewhere does not help."; OQ-30' },
  ELIG_REST_10H: { cites: 'Eligibility: "At least 10 hours have passed since their last shift ended, measured at the offered start time."' },
  ELIG_HOURS_60: { cites: 'Eligibility: "Hours worked in the trailing 7 days plus the offered hours do not exceed 60."; OQ-20' },
  ELIG_NO_SCHEDULE_OVERLAP: { cites: 'Eligibility: "The offer does not overlap a shift they are already scheduled for."; OQ-21' },
  ELIG_MIN_OFFER_2H: { cites: 'Eligibility: "Offers are at least 2 hours long. The estimated time to come online counts against the value of the offer."; OQ-08' },
  // Notification and Safety Constraints.
  SAFETY_ONE_OPEN_OFFER: { cites: 'Safety: "No more than one open offer per physician"' },
  SAFETY_THREE_OFFERS_PER_WEEK: { cites: 'Safety: "no more than 3 offers per physician per week"; OQ-09' },

  // Split-shift trap: brief "How Calls Reach Physicians", "The split-shift trap".
  TRAP_PRIORITY: { cites: 'Split-shift trap: "A physician who joins mid-shift starts with zero consults. Under rule 4, routing will send them nearly every call"' },
  TRAP_SCOPE: { cites: 'Split-shift trap mitigation: "limiting the joining physician to the gap hospitals"; OQ-35' },
  TRAP_SEED: { cites: 'Split-shift trap mitigation: "seeding a starting consult count"; OQ-35' },
} as const;

export type RuleCode = keyof typeof RULES;

/**
 * Derived-state labels as they appear in snapshot_physicians_*.csv
 * (derived_state column). "In Meeting" is the brief's self-reported status
 * value; the reference snapshot has no physician in that state.
 */
export const DERIVED_STATE_LABELS = {
  incoming_call: 'Incoming Hospital Call',
  outgoing_call: 'Outgoing Hospital Call',
  video: 'Video Consult In Progress',
  camera_without_synapse: 'Camera Active - No Synapse Session',
  temporarily_unavailable: 'Temporarily Unavailable',
  documentation: 'Documentation / Note',
  in_meeting: 'In Meeting',
  available: 'Available',
} as const;

export type DerivedStateKey = keyof typeof DERIVED_STATE_LABELS;
export type DerivedStateLabel = (typeof DERIVED_STATE_LABELS)[DerivedStateKey];

export const PHYSICIAN_FLAG_CODES = [
  'EXTERNAL_VIDEO_SUSPECTED',
  'AGENT_OFFLINE_UNVERIFIED',
  'TEMP_UNAVAILABLE_WITH_ASSIGNED',
  'RINGING_UNANSWERED',
  'IN_MEETING_INTERRUPTIBLE',
] as const;
export type PhysicianFlagCode = (typeof PHYSICIAN_FLAG_CODES)[number];
