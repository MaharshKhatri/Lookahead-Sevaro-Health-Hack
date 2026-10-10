import {
  AGENT_BACK_ONLINE_ON_CAMERA_EVENT,
  CONSULT_TYPE_DESCRIPTION_SUFFIX,
  PHONE_ONLY_DESCRIPTION_MARKER,
  SHIFT_COUNTERS_RESET_ON_SHIFT_STARTED,
  STAGE_REENTRY_KEEPS_ENTRY_TIME,
  STATUS_DESCRIPTION_PREFIX,
} from '../policy';
import { etDateOf, etWallClockToEpoch } from '../time';
import {
  CONSULT_STAGES,
  CONSULT_TYPES,
  SELF_REPORTED_STATUSES,
  type ConsultStage,
  type ConsultType,
  type Dataset,
  type EpochMs,
  type RawEvent,
  type SelfReportedStatus,
} from '../types';
import { finalize, type ConsultDraft, type PhysicianDraft, type ReplayContext } from './derive';
import { dedupe, eventRef, knownAt, lateEvents, orderByEventTime } from './normalize';
import type { DuplicateRecord, NetworkState, ReplayMode } from './types';

export interface ReplayOptions {
  /**
   * 'correct' (default): dedupe (OQ-04) -> events known at asOf -> event-time order, each applied at event_time.
   * 'naive': arrival (array) order, no dedupe, each applied at ingested_at. For the Integrity panel only.
   */
  readonly mode?: ReplayMode;
}

interface Plan {
  readonly events: readonly RawEvent[];
  readonly at: (e: RawEvent) => EpochMs;
  readonly duplicates: readonly DuplicateRecord[];
  readonly warnings: readonly string[];
}

/** Rebuilds network state as the system knows it at `asOfMs`. Pure; never mutates the dataset. */
export function replay(dataset: Dataset, asOfMs: EpochMs, opts: ReplayOptions = {}): NetworkState {
  const mode = opts.mode ?? 'correct';
  const plan = mode === 'correct' ? correctPlan(dataset.events, asOfMs) : naivePlan(dataset.events, asOfMs);
  const ctx = createContext(dataset, asOfMs, mode, plan.at);
  for (const e of plan.events) {
    if (applyEvent(ctx, e)) ctx.applied++;
    else ctx.ignored++;
  }
  return finalize(ctx, {
    duplicates: plan.duplicates,
    lateEvents: lateEvents(plan.events),
    warnings: [...plan.warnings, ...ctx.warnings],
  });
}

function correctPlan(events: readonly RawEvent[], asOfMs: EpochMs): Plan {
  const { events: unique, duplicates, warnings } = dedupe(events);
  const known = knownAt(unique, asOfMs);
  // An event cannot be applied before it happens, even if it is already known.
  const occurred = known.filter((e) => e.eventTime <= asOfMs);
  const deferred = known.length - occurred.length;
  const deferNote = deferred > 0 ? [`${deferred} known event(s) dated after asOf deferred until their event_time`] : [];
  return { events: orderByEventTime(occurred), at: (e) => e.eventTime, duplicates, warnings: [...warnings, ...deferNote] };
}

function naivePlan(events: readonly RawEvent[], asOfMs: EpochMs): Plan {
  return { events: knownAt(events, asOfMs), at: (e) => e.ingestedAt, duplicates: [], warnings: [] };
}

function createContext(dataset: Dataset, asOfMs: EpochMs, mode: ReplayMode, at: (e: RawEvent) => EpochMs): ReplayContext {
  const latest = dataset.events.reduce((m, e) => Math.max(m, e.eventTime), Number.NEGATIVE_INFINITY);
  // OQ-13: date-less clock values are ET on the ET date of the latest event_time.
  const scenarioDate = etDateOf(Number.isFinite(latest) ? latest : asOfMs);
  const names = new Map<string, string>();
  for (const p of [...dataset.credentials, ...dataset.offShiftRoster, ...dataset.physiciansOnShift]) names.set(p.physicianId, p.name);
  const physicians = new Map<string, PhysicianDraft>();
  for (const p of dataset.physiciansOnShift) {
    const startMs = etWallClockToEpoch(scenarioDate, p.shiftStartEt.secondOfDay);
    const endSec = p.shiftEndEt.secondOfDay + (p.shiftEndEt.secondOfDay <= p.shiftStartEt.secondOfDay ? 86_400 : 0);
    physicians.set(p.physicianId, newPhysician(p.physicianId, p.name, true, { startMs, endMs: etWallClockToEpoch(scenarioDate, endSec) }));
  }
  return {
    dataset,
    asOfMs,
    mode,
    at,
    scenarioDate,
    physicians,
    consults: new Map(),
    refs: new Map(),
    hospitalNames: new Map(dataset.hospitals.map((h) => [h.hospitalId, h.hospitalName])),
    physicianNames: names,
    warnings: [],
    applied: 0,
    ignored: 0,
  };
}

function newPhysician(physicianId: string, name: string | null, onRoster: boolean, shift: PhysicianDraft['shift']): PhysicianDraft {
  return {
    physicianId,
    name,
    onRoster,
    shift,
    shiftStartedMs: null,
    shiftStartedBy: null,
    status: { value: null, sinceMs: null, because: [] },
    agent: { online: true, sinceMs: null, because: [] },
    camera: { active: false, sinceMs: null, because: [] },
    activeCalls: [],
    activeVideo: null,
    ringing: null,
    lastCallEndedMs: null,
    lastCallEndedBy: null,
    lastVideoEndedMs: null,
    consultsThisShift: 0,
    callsThisShift: 0,
    lastAnsweredMs: null,
  };
}

// ---------- dispatch ----------

/** Applies one event; returns false when the event could not be applied at all (counted as ignored). */
function applyEvent(ctx: ReplayContext, e: RawEvent): boolean {
  ctx.refs.set(e.eventId, eventRef(e));
  const t = ctx.at(e);
  switch (e.eventType) {
    case 'consult_received':
      return onConsultReceived(ctx, e, t);
    case 'consult_triaged':
      return onStageEvent(ctx, e, t, 'Triaged');
    case 'physician_assigned':
      return onPhysicianAssigned(ctx, e, t);
    case 'incoming_call_ringing':
      return onRinging(ctx, e, t);
    case 'incoming_call_started':
      return onCallStarted(ctx, e, t, 'incoming');
    case 'incoming_call_ended':
      return onCallEnded(ctx, e, t, 'incoming');
    case 'outgoing_call_started':
      return onCallStarted(ctx, e, t, 'outgoing');
    case 'outgoing_call_ended':
      return onCallEnded(ctx, e, t, 'outgoing');
    case 'imaging_requested':
      return onStageEvent(ctx, e, t, 'CT/CTA or Imaging Pending');
    case 'imaging_returned':
      return onStageEvent(ctx, e, t, 'Imaging Review');
    case 'video_started':
      return onVideoStarted(ctx, e, t);
    case 'video_ended':
      return onVideoEnded(ctx, e, t);
    case 'note_started':
      return onStageEvent(ctx, e, t, 'Documentation');
    case 'note_signed':
      return onStageEvent(ctx, e, t, 'Signed Off');
    case 'routing_attempt_failed':
      return onRoutingFailed(ctx, e, t);
    case 'physician_status_changed':
      return onStatusChanged(ctx, e, t);
    case 'camera_active':
      return onCamera(ctx, e, t, true);
    case 'camera_inactive':
      return onCamera(ctx, e, t, false);
    case 'agent_heartbeat_lost':
      return onHeartbeatLost(ctx, e, t);
    case 'shift_started':
      return onShiftStarted(ctx, e, t);
    default: {
      const unhandled: never = e.eventType;
      ctx.warnings.push(`${e.eventId}: unhandled event type ${String(unhandled)}`);
      return false;
    }
  }
}

// ---------- lookups ----------

function physicianFor(ctx: ReplayContext, e: RawEvent): PhysicianDraft | null {
  if (e.physicianId === null) {
    ctx.warnings.push(`${e.eventId}: ${e.eventType} has no physician_id; ignored`);
    return null;
  }
  let p = ctx.physicians.get(e.physicianId);
  if (p === undefined) {
    ctx.warnings.push(`${e.eventId}: physician ${e.physicianId} is not in physicians_on_shift.csv; tracked anyway`);
    p = newPhysician(e.physicianId, ctx.physicianNames.get(e.physicianId) ?? null, false, null);
    ctx.physicians.set(e.physicianId, p);
  }
  return p;
}

function consultFor(ctx: ReplayContext, e: RawEvent, creating = false): ConsultDraft | null {
  if (e.consultId === null) {
    ctx.warnings.push(`${e.eventId}: ${e.eventType} has no consult_id; ignored`);
    return null;
  }
  let c = ctx.consults.get(e.consultId);
  if (c === undefined) {
    if (!creating) ctx.warnings.push(`${e.eventId}: ${e.eventType} for consult ${e.consultId} before any consult_received; tracked anyway`);
    c = newConsult(e.consultId, e.hospitalId);
    ctx.consults.set(e.consultId, c);
  }
  c.events.push(e.eventId);
  return c;
}

function newConsult(consultId: string, hospitalId: string | null): ConsultDraft {
  return {
    consultId,
    hospitalId,
    consultType: null,
    phoneOnly: false,
    receivedMs: null,
    stage: null,
    stageEnteredMs: null,
    stageHistory: [],
    assignedPhysicianId: null,
    assignmentHistory: [],
    contactedMs: null,
    routingFailures: [],
    ringingTo: null,
    noteClockStartMs: null,
    signedMs: null,
    open: true,
    events: [],
    lastCallEndMs: null,
    lastVideoEndMs: null,
  };
}

const STAGE_INDEX = new Map<ConsultStage, number>(CONSULT_STAGES.map((s, i) => [s, i]));
const NOTE_STAGES: ReadonlySet<ConsultStage> = new Set(['Note Pending', 'Documentation']);

/**
 * Brief "Consult lifecycle" (stage order) with OQ-18's event mapping. OQ-25:
 * re-entering the current stage keeps its entry time; moving backwards is
 * applied with a warning (STAGE_REGRESSION). Nothing changes after Signed Off.
 */
function enterStage(ctx: ReplayContext, c: ConsultDraft, stage: ConsultStage, t: EpochMs, e: RawEvent): void {
  if (!c.open) {
    ctx.warnings.push(`${e.eventId}: ${e.eventType} after consult ${c.consultId} was signed off; stage unchanged`);
    return;
  }
  if (c.stage === stage && STAGE_REENTRY_KEEPS_ENTRY_TIME) return;
  if (c.stage !== null && (STAGE_INDEX.get(stage) ?? 0) < (STAGE_INDEX.get(c.stage) ?? 0)) {
    ctx.warnings.push(`${e.eventId}: consult ${c.consultId} moves backwards from ${c.stage} to ${stage}`);
  }
  c.stage = stage;
  c.stageEnteredMs = t;
  c.stageHistory.push({ stage, enteredMs: t, eventId: e.eventId });
  // OQ-18: the note clock runs "from end of video or call" (brief "Operational Standards").
  if (NOTE_STAGES.has(stage) && c.noteClockStartMs === null) c.noteClockStartMs = maxOrNull(c.lastVideoEndMs, c.lastCallEndMs) ?? t;
  if (stage === 'Signed Off') {
    c.open = false;
    c.signedMs = t;
  }
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

// ---------- consult handlers ----------

function onConsultReceived(ctx: ReplayContext, e: RawEvent, t: EpochMs): boolean {
  const c = consultFor(ctx, e, true);
  if (c === null) return false;
  if (c.receivedMs !== null) ctx.warnings.push(`${e.eventId}: consult ${c.consultId} received a second time`);
  c.receivedMs = t;
  c.hospitalId = e.hospitalId ?? c.hospitalId;
  c.consultType = parseConsultType(ctx, e);
  enterStage(ctx, c, 'Received', t, e);
  return true;
}

/** OQ-14: the consult type exists only as "<type> consult request received". */
function parseConsultType(ctx: ReplayContext, e: RawEvent): ConsultType | null {
  const d = e.description;
  const type = d.endsWith(CONSULT_TYPE_DESCRIPTION_SUFFIX) ? d.slice(0, -CONSULT_TYPE_DESCRIPTION_SUFFIX.length) : null;
  const known = CONSULT_TYPES.find((k) => k === type);
  if (known === undefined) ctx.warnings.push(`${e.eventId}: consult type not recognised in description "${d}"`);
  return known ?? null;
}

function onStageEvent(ctx: ReplayContext, e: RawEvent, t: EpochMs, stage: ConsultStage): boolean {
  const c = consultFor(ctx, e);
  if (c === null) return false;
  enterStage(ctx, c, stage, t, e);
  return true;
}

function onPhysicianAssigned(ctx: ReplayContext, e: RawEvent, t: EpochMs): boolean {
  const p = physicianFor(ctx, e);
  const c = p === null ? null : consultFor(ctx, e);
  if (p === null || c === null) return false;
  c.assignedPhysicianId = p.physicianId;
  c.assignmentHistory.push({ physicianId: p.physicianId, atMs: t, eventId: e.eventId });
  enterStage(ctx, c, 'Assigned', t, e);
  p.consultsThisShift++; // OQ-11: consults_this_shift counts physician_assigned.
  return true;
}

/** OQ-17: ringing marks the physician's phone (routing rule 2); it neither assigns nor changes stage. */
function onRinging(ctx: ReplayContext, e: RawEvent, t: EpochMs): boolean {
  const p = physicianFor(ctx, e);
  if (p === null) return false;
  p.ringing = { consultId: e.consultId, hospitalId: e.hospitalId, sinceMs: t, eventId: e.eventId };
  const c = e.consultId === null ? null : consultFor(ctx, e);
  if (c !== null) c.ringingTo = { physicianId: p.physicianId, sinceMs: t };
  return true;
}

function onCallStarted(ctx: ReplayContext, e: RawEvent, t: EpochMs, direction: 'incoming' | 'outgoing'): boolean {
  const p = physicianFor(ctx, e);
  if (p === null) return false;
  p.activeCalls.push({ direction, consultId: e.consultId, hospitalId: e.hospitalId, startedMs: t, eventId: e.eventId });
  p.callsThisShift++; // OQ-11: calls_this_shift = incoming + outgoing call starts.
  if (direction === 'incoming') p.lastAnsweredMs = t;
  p.ringing = null; // OQ-17: ringing lasts until the physician's next call event.
  const c = e.consultId === null ? null : consultFor(ctx, e);
  if (c !== null) {
    c.contactedMs ??= t;
    if (direction === 'incoming') {
      c.ringingTo = null;
      // OQ-18: incoming_call_started moves Assigned -> Provider Contacted; later calls do not change stage.
      if (c.stage === 'Assigned') enterStage(ctx, c, 'Provider Contacted', t, e);
    }
  }
  return true;
}

function onCallEnded(ctx: ReplayContext, e: RawEvent, t: EpochMs, direction: 'incoming' | 'outgoing'): boolean {
  const p = physicianFor(ctx, e);
  if (p === null) return false;
  const i = p.activeCalls.findIndex((x) => x.direction === direction && x.consultId === e.consultId);
  if (i < 0) ctx.warnings.push(`${e.eventId}: ${e.eventType} without a matching ${direction} call for ${p.physicianId}`);
  else p.activeCalls.splice(i, 1);
  p.lastCallEndedMs = t;
  p.lastCallEndedBy = eventRef(e);
  p.ringing = null;
  const c = e.consultId === null ? null : consultFor(ctx, e);
  if (c !== null) {
    c.lastCallEndMs = t;
    // OQ-18 / OQ-14: a call end marked phone-only ends the clinical interaction ("Phone-only consults skip video").
    if (e.description.includes(PHONE_ONLY_DESCRIPTION_MARKER)) {
      c.phoneOnly = true;
      enterStage(ctx, c, 'Note Pending', t, e);
    }
  }
  return true;
}

function onVideoStarted(ctx: ReplayContext, e: RawEvent, t: EpochMs): boolean {
  const p = physicianFor(ctx, e);
  if (p === null) return false;
  if (p.activeVideo !== null) ctx.warnings.push(`${e.eventId}: video_started while ${p.physicianId} already has video ${p.activeVideo.eventId} open`);
  else p.activeVideo = { consultId: e.consultId, hospitalId: e.hospitalId, startedMs: t, eventId: e.eventId };
  const c = e.consultId === null ? null : consultFor(ctx, e);
  if (c !== null) enterStage(ctx, c, 'Video Consult In Progress', t, e);
  return true;
}

function onVideoEnded(ctx: ReplayContext, e: RawEvent, t: EpochMs): boolean {
  const p = physicianFor(ctx, e);
  if (p === null) return false;
  if (p.activeVideo !== null && p.activeVideo.consultId === e.consultId) p.activeVideo = null;
  else ctx.warnings.push(`${e.eventId}: video_ended without a matching video_started for ${p.physicianId}`);
  p.lastVideoEndedMs = t;
  const c = e.consultId === null ? null : consultFor(ctx, e);
  if (c !== null) {
    c.lastVideoEndMs = t;
    enterStage(ctx, c, 'Note Pending', t, e);
  }
  return true;
}

function onRoutingFailed(ctx: ReplayContext, e: RawEvent, t: EpochMs): boolean {
  const c = consultFor(ctx, e);
  if (c === null) return false;
  c.routingFailures.push({ atMs: t, eventId: e.eventId }); // brief routing rule 5
  return true;
}

// ---------- physician signal handlers (brief "Availability is inferred, not reported") ----------

function onStatusChanged(ctx: ReplayContext, e: RawEvent, t: EpochMs): boolean {
  const p = physicianFor(ctx, e);
  if (p === null) return false;
  const status = parseStatus(e.description);
  if (status === null) {
    ctx.warnings.push(`${e.eventId}: self-reported status not recognised in description "${e.description}"; ignored`);
    return false;
  }
  p.status = { value: status, sinceMs: t, because: [eventRef(e)] };
  return true;
}

/** OQ-14: "Self-reported status: <value>", value from the brief's list. */
function parseStatus(description: string): SelfReportedStatus | null {
  if (!description.startsWith(STATUS_DESCRIPTION_PREFIX)) return null;
  const value = description.slice(STATUS_DESCRIPTION_PREFIX.length).trim();
  return SELF_REPORTED_STATUSES.find((s) => s === value) ?? null;
}

function onCamera(ctx: ReplayContext, e: RawEvent, t: EpochMs, active: boolean): boolean {
  const p = physicianFor(ctx, e);
  if (p === null) return false;
  p.camera = { active, sinceMs: t, because: [eventRef(e)] };
  // OQ-16: any camera event proves the desktop agent is reporting again.
  if (AGENT_BACK_ONLINE_ON_CAMERA_EVENT && !p.agent.online) p.agent = { online: true, sinceMs: t, because: [eventRef(e)] };
  return true;
}

function onHeartbeatLost(ctx: ReplayContext, e: RawEvent, t: EpochMs): boolean {
  const p = physicianFor(ctx, e);
  if (p === null) return false;
  p.agent = { online: false, sinceMs: t, because: [eventRef(e)] };
  p.camera = { active: null, sinceMs: t, because: [eventRef(e)] }; // "offline means camera state is unknown"
  return true;
}

function onShiftStarted(ctx: ReplayContext, e: RawEvent, t: EpochMs): boolean {
  const p = physicianFor(ctx, e);
  if (p === null) return false;
  p.shiftStartedMs = t;
  p.shiftStartedBy = eventRef(e);
  if (SHIFT_COUNTERS_RESET_ON_SHIFT_STARTED) {
    p.consultsThisShift = 0;
    p.callsThisShift = 0;
  }
  return true;
}
