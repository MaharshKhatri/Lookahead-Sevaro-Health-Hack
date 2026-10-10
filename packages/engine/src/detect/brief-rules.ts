import type { ConsultStage, ConsultType } from '../types';

/**
 * Numeric rules stated by the brief (docs/brief_c2.md). These are facts, not
 * interpretations; interpretations live in src/policy.ts.
 */

/** "How Calls Reach Physicians" rule 2: "anyone who ended a call less than 2 minutes ago". */
export const CALL_COOLDOWN_MS = 2 * 60_000;

/** Rule 3: "6 or fewer consults on days, 4 or fewer on nights". */
export const LOW_VOLUME_MAX_CONSULTS = { day: 6, night: 4 } as const;

/** Rule 5: a failed routing attempt "retries every 5 minutes". */
export const ROUTING_RETRY_MS = 5 * 60_000;

/** "What Teams Must Demonstrate" #4: "Project coverage forward at least 90 minutes". */
export const MIN_PROJECTION_HORIZON_MIN = 90;

/** "Operational Standards": "Open notes within 60 min of the physician's shift end — All — Any / 2 or more". */
export const OPEN_NOTES_WINDOW_MS = 60 * 60_000;
export const OPEN_NOTES_WARNING_COUNT = 1;
export const OPEN_NOTES_CRITICAL_COUNT = 2;

export type StandardCode = 'TRIAGED_NOT_ASSIGNED' | 'ASSIGNED_NOT_CONTACTED' | 'IMAGING_PENDING' | 'IMAGING_REVIEW' | 'NOTE_COMPLETION';

export interface StandardDef {
  readonly code: StandardCode;
  /** Row label as written in the brief's table. */
  readonly label: string;
  readonly appliesTo: 'All' | readonly ConsultType[];
  /** Consult stages during which the clock runs. */
  readonly stages: readonly ConsultStage[];
  /** stage_entry: from entering the stage; note_clock: ConsultState.noteClockStartMs (OQ-18). */
  readonly clock: 'stage_entry' | 'note_clock';
  readonly warningMin: number;
  readonly criticalMin: number;
}

/** "Operational Standards (Synthetic)" table, row by row. */
export const OPERATIONAL_STANDARDS: readonly StandardDef[] = [
  { code: 'TRIAGED_NOT_ASSIGNED', label: 'Triaged, not yet assigned', appliesTo: 'All', stages: ['Triaged'], clock: 'stage_entry', warningMin: 5, criticalMin: 10 },
  { code: 'ASSIGNED_NOT_CONTACTED', label: 'Assigned, physician not yet contacted', appliesTo: ['Stroke'], stages: ['Assigned'], clock: 'stage_entry', warningMin: 3, criticalMin: 8 },
  { code: 'IMAGING_PENDING', label: 'CT/CTA or Imaging Pending', appliesTo: ['Stroke'], stages: ['CT/CTA or Imaging Pending'], clock: 'stage_entry', warningMin: 12, criticalMin: 20 },
  { code: 'IMAGING_REVIEW', label: 'Imaging Review (imaging back, video not started)', appliesTo: ['Stroke'], stages: ['Imaging Review'], clock: 'stage_entry', warningMin: 6, criticalMin: 12 },
  { code: 'NOTE_COMPLETION', label: 'Note Pending + Documentation, from end of video or call', appliesTo: ['Stroke'], stages: ['Note Pending', 'Documentation'], clock: 'note_clock', warningMin: 30, criticalMin: 45 },
  { code: 'NOTE_COMPLETION', label: 'Note Pending + Documentation, from end of video or call', appliesTo: ['General Neuro'], stages: ['Note Pending', 'Documentation'], clock: 'note_clock', warningMin: 45, criticalMin: 90 },
];
