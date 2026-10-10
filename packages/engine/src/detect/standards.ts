import { OPEN_NOTE_STAGES, OPEN_NOTES_WINDOW_INCLUSIVE } from '../policy';
import { compareIds } from '../replay/derive';
import type { RuleCode } from '../replay/rules';
import type { ConsultState, EventRef, NetworkState } from '../replay/types';
import type { ConsultType, EpochMs } from '../types';
import { OPEN_NOTES_CRITICAL_COUNT, OPEN_NOTES_WARNING_COUNT, OPEN_NOTES_WINDOW_MS, OPERATIONAL_STANDARDS, type StandardCode, type StandardDef } from './brief-rules';
import type { StaffingModel } from './staffing';

export type Level = 'ok' | 'warning' | 'critical';

export interface StandardEvaluation {
  readonly consultId: string;
  readonly hospitalId: string | null;
  readonly consultType: ConsultType | null;
  readonly standard: StandardCode;
  readonly label: string;
  readonly clockStartMs: EpochMs;
  readonly elapsedMs: number;
  readonly level: Level;
  readonly warnAtMs: EpochMs;
  readonly criticalAtMs: EpochMs;
  readonly rule: RuleCode;
  readonly because: readonly EventRef[];
}

/**
 * Brief "Operational Standards": every standard that applies to each open
 * consult's current stage and type. Breach comparison per OQ-05 (>= on exact
 * elapsed). warnAtMs / criticalAtMs are returned even when ok, so callers can
 * say "breaches in 2 min".
 */
export function evaluateStandards(state: NetworkState, staffing: StaffingModel, nowMs: EpochMs): StandardEvaluation[] {
  const out: StandardEvaluation[] = [];
  const open = Object.values(state.consults)
    .filter((c) => c.open)
    .sort((a, b) => compareIds(a.consultId, b.consultId));
  for (const c of open) {
    for (const def of OPERATIONAL_STANDARDS) {
      const e = evaluate(c, def, staffing, nowMs);
      if (e !== null) out.push(e);
    }
  }
  return out;
}

function applies(def: StandardDef, c: ConsultState): boolean {
  if (c.stage === null || !def.stages.includes(c.stage)) return false;
  return def.appliesTo === 'All' || (c.consultType !== null && def.appliesTo.includes(c.consultType));
}

function evaluate(c: ConsultState, def: StandardDef, staffing: StaffingModel, nowMs: EpochMs): StandardEvaluation | null {
  if (!applies(def, c)) return null;
  const clockStartMs = def.clock === 'stage_entry' ? c.stageEnteredMs : c.noteClockStartMs;
  if (clockStartMs === null) return null;
  const elapsedMs = nowMs - clockStartMs;
  const warnAtMs = clockStartMs + def.warningMin * 60_000;
  const criticalAtMs = clockStartMs + def.criticalMin * 60_000;
  // OQ-05: a threshold is reached when elapsed >= threshold.
  const level: Level = nowMs >= criticalAtMs ? 'critical' : nowMs >= warnAtMs ? 'warning' : 'ok';
  return {
    consultId: c.consultId,
    hospitalId: c.hospitalId,
    consultType: c.consultType,
    standard: def.code,
    label: def.label,
    clockStartMs,
    elapsedMs,
    level,
    warnAtMs,
    criticalAtMs,
    rule: def.clock === 'note_clock' ? 'STANDARD_NOTE_CLOCK' : 'STANDARD_TIME_IN_STAGE',
    because: clockRefs(c, def, staffing),
  };
}

/** The stage-entry event, plus (for the note clock) the video/call end that started it (OQ-18). */
function clockRefs(c: ConsultState, def: StandardDef, staffing: StaffingModel): EventRef[] {
  const entry = c.stageHistory.at(-1);
  const refs: EventRef[] = [];
  if (def.clock === 'note_clock') {
    const anchor = c.events
      .map((id) => staffing.refs.get(id))
      .find((r) => r !== undefined && r.eventTimeMs === c.noteClockStartMs && ['video_ended', 'incoming_call_ended', 'outgoing_call_ended'].includes(r.eventType));
    if (anchor !== undefined) refs.push(anchor);
  }
  const entryRef = entry === undefined ? undefined : staffing.refs.get(entry.eventId);
  if (entryRef !== undefined && !refs.some((r) => r.eventId === entryRef.eventId)) refs.push(entryRef);
  return refs;
}

export interface OpenNotesEvaluation {
  readonly physicianId: string;
  readonly name: string | null;
  readonly shiftEndMs: EpochMs;
  readonly windowEntersAtMs: EpochMs;
  readonly inWindow: boolean;
  readonly afterShiftEnd: boolean;
  readonly noteConsultIds: readonly string[];
  readonly count: number;
  /** Level now (ok outside the window). */
  readonly level: Level;
  /** Level once the window opens if the same notes are still open (for projection). */
  readonly levelAtWindow: Level;
  readonly rule: RuleCode;
  readonly because: readonly EventRef[];
}

/** Brief "Operational Standards": "Open notes within 60 min of the physician's shift end", Any = warning, 2 or more = critical (OQ-22). */
export function evaluateOpenNotes(state: NetworkState, staffing: StaffingModel, nowMs: EpochMs): OpenNotesEvaluation[] {
  return Object.values(state.physicians)
    .filter((p) => p.onRoster && p.shift !== null)
    .map((p) => {
      const shiftEndMs = p.shift?.endMs ?? 0;
      const windowEntersAtMs = shiftEndMs - OPEN_NOTES_WINDOW_MS;
      const inWindow = OPEN_NOTES_WINDOW_INCLUSIVE ? nowMs >= windowEntersAtMs : nowMs > windowEntersAtMs;
      const notes = p.openConsultIds.map((id) => state.consults[id]).filter((c): c is ConsultState => c !== undefined && c.stage !== null && OPEN_NOTE_STAGES.includes(c.stage));
      const levelAtWindow = levelFor(notes.length);
      return {
        physicianId: p.physicianId,
        name: p.name,
        shiftEndMs,
        windowEntersAtMs,
        inWindow,
        afterShiftEnd: nowMs >= shiftEndMs,
        noteConsultIds: notes.map((c) => c.consultId),
        count: notes.length,
        level: inWindow ? levelAtWindow : 'ok',
        levelAtWindow,
        rule: 'STANDARD_OPEN_NOTES_NEAR_SHIFT_END',
        because: notes.flatMap((c) => {
          const r = staffing.refs.get(c.stageHistory.at(-1)?.eventId ?? '');
          return r === undefined ? [] : [r];
        }),
      };
    });
}

function levelFor(count: number): Level {
  if (count >= OPEN_NOTES_CRITICAL_COUNT) return 'critical';
  if (count >= OPEN_NOTES_WARNING_COUNT) return 'warning';
  return 'ok';
}
