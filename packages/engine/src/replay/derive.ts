import { DERIVED_STATE_PRECEDENCE, RINGING_TIMEOUT_MS } from '../policy';
import type { ConsultStage, ConsultType, Dataset, EpochMs, RawEvent, SelfReportedStatus } from '../types';
import { DERIVED_STATE_LABELS, type DerivedStateKey, type DerivedStateLabel, type RuleCode } from './rules';
import type {
  ActiveCall,
  ActiveVideo,
  ConsultState,
  DuplicateRecord,
  EventRef,
  LateEventRecord,
  NetworkState,
  PhysicianFlag,
  PhysicianState,
  Provenanced,
  ReplayMode,
  Ringing,
  StageEntry,
} from './types';

/** Mutable working copy of a physician during the fold (never exposed). */
export interface PhysicianDraft {
  physicianId: string;
  name: string | null;
  onRoster: boolean;
  shift: { startMs: EpochMs; endMs: EpochMs } | null;
  shiftStartedMs: EpochMs | null;
  status: { value: SelfReportedStatus | null; sinceMs: EpochMs | null; because: EventRef[] };
  agent: { online: boolean; sinceMs: EpochMs | null; because: EventRef[] };
  camera: { active: boolean | null; sinceMs: EpochMs | null; because: EventRef[] };
  activeCalls: ActiveCall[];
  activeVideo: ActiveVideo | null;
  ringing: Ringing | null;
  lastCallEndedMs: EpochMs | null;
  lastVideoEndedMs: EpochMs | null;
  consultsThisShift: number;
  callsThisShift: number;
  lastAnsweredMs: EpochMs | null;
}

/** Mutable working copy of a consult during the fold (never exposed). */
export interface ConsultDraft {
  consultId: string;
  hospitalId: string | null;
  consultType: ConsultType | null;
  phoneOnly: boolean;
  receivedMs: EpochMs | null;
  stage: ConsultStage | null;
  stageEnteredMs: EpochMs | null;
  stageHistory: StageEntry[];
  assignedPhysicianId: string | null;
  assignmentHistory: { physicianId: string; atMs: EpochMs; eventId: string }[];
  contactedMs: EpochMs | null;
  routingFailures: { atMs: EpochMs; eventId: string }[];
  ringingTo: { physicianId: string; sinceMs: EpochMs } | null;
  noteClockStartMs: EpochMs | null;
  signedMs: EpochMs | null;
  open: boolean;
  events: string[];
  lastCallEndMs: EpochMs | null;
  lastVideoEndMs: EpochMs | null;
}

export interface ReplayContext {
  readonly dataset: Dataset;
  readonly asOfMs: EpochMs;
  readonly mode: ReplayMode;
  readonly at: (e: RawEvent) => EpochMs;
  readonly scenarioDate: string;
  readonly physicians: Map<string, PhysicianDraft>;
  readonly consults: Map<string, ConsultDraft>;
  /** event_id -> reference of the applied event, for provenance. */
  readonly refs: Map<string, EventRef>;
  readonly hospitalNames: ReadonlyMap<string, string>;
  readonly physicianNames: ReadonlyMap<string, string>;
  readonly warnings: string[];
  applied: number;
  ignored: number;
}

interface Extras {
  readonly duplicates: readonly DuplicateRecord[];
  readonly lateEvents: readonly LateEventRecord[];
  readonly warnings: readonly string[];
}

/** Freezes the fold into NetworkState, computing derived state and flags at asOf. */
export function finalize(ctx: ReplayContext, extras: Extras): NetworkState {
  const consults: Record<string, ConsultState> = {};
  for (const c of ctx.consults.values()) consults[c.consultId] = toConsultState(ctx, c);
  const openByPhysician = new Map<string, ConsultDraft[]>();
  for (const c of ctx.consults.values()) {
    if (!c.open || c.assignedPhysicianId === null) continue;
    openByPhysician.set(c.assignedPhysicianId, [...(openByPhysician.get(c.assignedPhysicianId) ?? []), c]);
  }
  const physicians: Record<string, PhysicianState> = {};
  for (const p of ctx.physicians.values()) {
    const open = [...(openByPhysician.get(p.physicianId) ?? [])].sort((a, b) => compareIds(a.consultId, b.consultId));
    physicians[p.physicianId] = toPhysicianState(ctx, p, open);
  }
  return {
    asOfMs: ctx.asOfMs,
    mode: ctx.mode,
    scenarioDate: ctx.scenarioDate,
    physicians,
    consults,
    integrity: {
      duplicates: extras.duplicates,
      lateEvents: extras.lateEvents,
      warnings: extras.warnings,
      appliedCount: ctx.applied,
      ignoredCount: ctx.ignored,
    },
  };
}

export function compareIds(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

function toConsultState(ctx: ReplayContext, c: ConsultDraft): ConsultState {
  return {
    consultId: c.consultId,
    hospitalId: c.hospitalId,
    hospitalName: c.hospitalId === null ? null : (ctx.hospitalNames.get(c.hospitalId) ?? null),
    consultType: c.consultType,
    phoneOnly: c.phoneOnly,
    receivedMs: c.receivedMs,
    stage: c.stage,
    stageEnteredMs: c.stageEnteredMs,
    stageHistory: [...c.stageHistory],
    assignedPhysicianId: c.assignedPhysicianId,
    assignmentHistory: [...c.assignmentHistory],
    contactedMs: c.contactedMs,
    routingFailures: [...c.routingFailures],
    ringingTo: c.ringingTo,
    noteClockStartMs: c.noteClockStartMs,
    signedMs: c.signedMs,
    open: c.open,
    events: [...c.events],
  };
}

function toPhysicianState(ctx: ReplayContext, p: PhysicianDraft, open: readonly ConsultDraft[]): PhysicianState {
  return {
    physicianId: p.physicianId,
    name: p.name,
    onRoster: p.onRoster,
    shift: p.shift,
    shiftStartedMs: p.shiftStartedMs,
    selfStatus: { value: p.status.value, because: p.status.because, rule: 'STATUS_SELF_REPORTED' },
    agent: { ...p.agent },
    camera: { ...p.camera },
    activeCalls: [...p.activeCalls],
    activeVideo: p.activeVideo,
    ringing: p.ringing,
    lastCallEndedMs: p.lastCallEndedMs,
    lastVideoEndedMs: p.lastVideoEndedMs,
    consultsThisShift: p.consultsThisShift,
    callsThisShift: p.callsThisShift,
    lastAnsweredMs: p.lastAnsweredMs,
    openConsultIds: open.map((c) => c.consultId),
    derivedState: derivedState(ctx, p, open),
    flags: flags(ctx, p, open),
  };
}

const ref = (ctx: ReplayContext, eventId: string): EventRef[] => {
  const r = ctx.refs.get(eventId);
  return r === undefined ? [] : [r];
};

/** Camera on, agent reporting, no Synapse video, status not In Meeting (brief "Availability"). */
function cameraWithoutSynapse(p: PhysicianDraft): boolean {
  return p.agent.online && p.camera.active === true && p.activeVideo === null && p.status.value !== 'In Meeting';
}

function documenting(open: readonly ConsultDraft[]): ConsultDraft[] {
  return open.filter((c) => c.stage === 'Documentation');
}

const lastStageEvent = (c: ConsultDraft): string | null => c.stageHistory.at(-1)?.eventId ?? null;

/** OQ-15: first matching key of DERIVED_STATE_PRECEDENCE wins. */
function derivedState(ctx: ReplayContext, p: PhysicianDraft, open: readonly ConsultDraft[]): Provenanced<DerivedStateLabel> {
  const candidates: Record<DerivedStateKey, () => { because: EventRef[]; rule: RuleCode } | null> = {
    incoming_call: () => callCandidate(ctx, p, 'incoming', 'DERIVED_INCOMING_CALL'),
    outgoing_call: () => callCandidate(ctx, p, 'outgoing', 'DERIVED_OUTGOING_CALL'),
    video: () => (p.activeVideo === null ? null : { because: ref(ctx, p.activeVideo.eventId), rule: 'DERIVED_VIDEO' }),
    camera_without_synapse: () =>
      cameraWithoutSynapse(p) ? { because: [...p.camera.because, ...p.status.because], rule: 'DERIVED_CAMERA_NO_SYNAPSE' } : null,
    temporarily_unavailable: () =>
      p.status.value === 'Temporarily Unavailable' ? { because: p.status.because, rule: 'DERIVED_TEMP_UNAVAILABLE' } : null,
    documentation: () => {
      const docs = documenting(open);
      if (docs.length === 0) return null;
      return { because: docs.flatMap((c) => ref(ctx, lastStageEvent(c) ?? '')), rule: 'DERIVED_DOCUMENTATION' };
    },
    in_meeting: () => (p.status.value === 'In Meeting' ? { because: p.status.because, rule: 'DERIVED_IN_MEETING' } : null),
    available: () => ({ because: p.status.because, rule: 'DERIVED_AVAILABLE' }),
  };
  for (const key of DERIVED_STATE_PRECEDENCE) {
    const hit = candidates[key]();
    if (hit !== null) return { value: DERIVED_STATE_LABELS[key], ...hit };
  }
  return { value: DERIVED_STATE_LABELS.available, because: [], rule: 'DERIVED_AVAILABLE' };
}

function callCandidate(ctx: ReplayContext, p: PhysicianDraft, direction: 'incoming' | 'outgoing', rule: RuleCode) {
  const calls = p.activeCalls.filter((c) => c.direction === direction);
  return calls.length === 0 ? null : { because: calls.flatMap((c) => ref(ctx, c.eventId)), rule };
}

function flags(ctx: ReplayContext, p: PhysicianDraft, open: readonly ConsultDraft[]): PhysicianFlag[] {
  const out: PhysicianFlag[] = [];
  if (cameraWithoutSynapse(p)) {
    out.push({
      value: { code: 'EXTERNAL_VIDEO_SUSPECTED', sinceMs: p.camera.sinceMs ?? ctx.asOfMs },
      because: [...p.camera.because, ...p.status.because],
      rule: 'FLAG_EXTERNAL_VIDEO',
    });
  }
  if (!p.agent.online) {
    out.push({ value: { code: 'AGENT_OFFLINE_UNVERIFIED', sinceMs: p.agent.sinceMs ?? ctx.asOfMs }, because: p.agent.because, rule: 'FLAG_AGENT_OFFLINE' });
  }
  if (p.status.value === 'Temporarily Unavailable' && open.length > 0) {
    const assignments = open.flatMap((c) => ref(ctx, c.assignmentHistory.at(-1)?.eventId ?? ''));
    out.push({
      value: { code: 'TEMP_UNAVAILABLE_WITH_ASSIGNED', sinceMs: p.status.sinceMs ?? ctx.asOfMs, consultIds: open.map((c) => c.consultId) },
      because: [...p.status.because, ...assignments],
      rule: 'FLAG_TEMP_UNAVAILABLE_ASSIGNED',
    });
  }
  const ringing = p.ringing;
  if (ringing !== null && (RINGING_TIMEOUT_MS === null || ctx.asOfMs - ringing.sinceMs <= RINGING_TIMEOUT_MS)) {
    out.push({
      value: {
        code: 'RINGING_UNANSWERED',
        sinceMs: ringing.sinceMs,
        consultId: ringing.consultId,
        seconds: Math.floor((ctx.asOfMs - ringing.sinceMs) / 1000),
      },
      because: ref(ctx, ringing.eventId),
      rule: 'FLAG_RINGING_UNANSWERED',
    });
  }
  if (p.status.value === 'In Meeting') {
    const cameraActive = p.agent.online && p.camera.active === true;
    out.push({
      value: { code: 'IN_MEETING_INTERRUPTIBLE', sinceMs: p.status.sinceMs ?? ctx.asOfMs, cameraActive },
      because: [...p.status.because, ...(cameraActive ? p.camera.because : [])],
      rule: 'FLAG_IN_MEETING_INTERRUPTIBLE',
    });
  }
  return out;
}
