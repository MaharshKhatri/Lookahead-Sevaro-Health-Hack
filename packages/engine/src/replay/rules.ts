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
