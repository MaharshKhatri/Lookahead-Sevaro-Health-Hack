import { compareIds } from '../replay/derive';
import type { RuleCode } from '../replay/rules';
import type { ConsultState, EventRef, NetworkState, PhysicianState } from '../replay/types';
import type { EpochMs } from '../types';
import { CALL_COOLDOWN_MS, LOW_VOLUME_MAX_CONSULTS } from './brief-rules';
import { etClock, etClockS, isCredentialed, shiftOf, type StaffingModel } from './staffing';

/**
 * Routability now: brief "How Calls Reach Physicians" rules 1-2 = OQ-24(b)
 * "ROUTABLE NOW". Kept separate from staffed capacity (OQ-24(a), coverage.ts).
 */

export interface RouteCheck {
  readonly rule: RuleCode;
  readonly pass: boolean;
  /** routable: a failure removes the physician; verified: a failure only marks the result unverified; info: never fails. */
  readonly affects: 'routable' | 'verified' | 'info';
  readonly detail: string;
  readonly because: readonly EventRef[];
  /** True for OQ-23, which is inferred from the data rather than stated by the brief. */
  readonly inferred?: boolean;
}

export interface Routability {
  readonly physicianId: string;
  readonly hospitalId: string;
  readonly routable: boolean;
  /** False when the physician's presence agent is offline or has never reported (brief: "unverified"). */
  readonly verified: boolean;
  readonly reasons: readonly RouteCheck[];
}

export interface RouteOptions {
  /** The consult being routed: its own ringing or pending contact is not "another call". */
  readonly forConsultId?: string;
  /** Routability already computed for this hospital and instant (same forConsultId), keyed by physician. */
  readonly precomputed?: Readonly<Record<string, Routability>>;
}

export function routableNow(
  state: NetworkState,
  staffing: StaffingModel,
  physicianId: string,
  hospitalId: string,
  nowMs: EpochMs,
  opts: RouteOptions = {},
): Routability {
  const p = state.physicians[physicianId];
  const reasons: RouteCheck[] = [onShiftCheck(staffing, p, physicianId, nowMs), credentialCheck(staffing, physicianId, hospitalId)];
  if (p === undefined) {
    reasons.push({ rule: 'ROUTE_AGENT_VERIFIED', pass: false, affects: 'verified', detail: 'no presence signals yet (scheduled shift, no events)', because: [] });
  } else {
    reasons.push(...signalChecks(state, staffing, p, nowMs, opts));
  }
  return {
    physicianId,
    hospitalId,
    routable: reasons.every((r) => r.affects !== 'routable' || r.pass),
    verified: reasons.every((r) => r.affects !== 'verified' || r.pass),
    reasons,
  };
}

/** Rule 1: on shift at now (start <= now < end), from the roster or a scheduled arrival (OQ-27). */
function onShiftCheck(staffing: StaffingModel, p: PhysicianState | undefined, physicianId: string, nowMs: EpochMs): RouteCheck {
  const shift = shiftOf(staffing, physicianId, nowMs);
  const because = p?.shiftStartedBy ? [p.shiftStartedBy] : [];
  if (shift !== null) {
    const src = shift.source === 'scheduled_arrival' ? ' (scheduled arrival, OQ-27)' : '';
    return { rule: 'ROUTE_ON_SHIFT', pass: true, affects: 'routable', detail: `on shift ${etClock(shift.startMs)}-${etClock(shift.endMs)} ET${src}`, because };
  }
  const own = staffing.shifts.find((s) => s.physicianId === physicianId);
  const detail = own === undefined ? 'not on shift (no shift known)' : `not on shift (shift ${etClock(own.startMs)}-${etClock(own.endMs)} ET)`;
  return { rule: 'ROUTE_ON_SHIFT', pass: false, affects: 'routable', detail, because };
}

function credentialCheck(staffing: StaffingModel, physicianId: string, hospitalId: string): RouteCheck {
  const ok = isCredentialed(staffing, physicianId, hospitalId);
  return { rule: 'ROUTE_CREDENTIALED', pass: ok, affects: 'routable', detail: ok ? `credentialed at ${hospitalId}` : `not credentialed at ${hospitalId}`, because: [] };
}

/** Rule 2 exclusions and the explicit non-exclusions (OQ-06, In Meeting) for a physician with replay state. */
function signalChecks(state: NetworkState, staffing: StaffingModel, p: PhysicianState, nowMs: EpochMs, opts: RouteOptions): RouteCheck[] {
  const refs = (ids: readonly string[]) => ids.map((id) => staffing.refs.get(id)).filter((r): r is EventRef => r !== undefined);
  const calls = p.activeCalls;
  const ext = p.flags.find((f) => f.value.code === 'EXTERNAL_VIDEO_SUSPECTED');
  const status = p.selfStatus.value;
  const ringing = p.ringing !== null && p.ringing.consultId !== (opts.forConsultId ?? null) ? p.ringing : null;
  const pending = pendingFirstContact(state, p, opts.forConsultId);
  const sinceCallEnd = p.lastCallEndedMs === null ? null : nowMs - p.lastCallEndedMs;
  const coolingDown = sinceCallEnd !== null && sinceCallEnd < CALL_COOLDOWN_MS;
  const documenting = p.openConsultIds.filter((id) => state.consults[id]?.stage === 'Documentation');
  return [
    {
      rule: 'ROUTE_NOT_ON_CALL',
      pass: calls.length === 0,
      affects: 'routable',
      detail: calls.length === 0 ? 'no active Synapse call' : `on ${calls.map((c) => `${c.direction} call for ${c.consultId ?? '?'} since ${etClockS(c.startedMs)}`).join(', ')}`,
      because: refs(calls.map((c) => c.eventId)),
    },
    {
      rule: 'ROUTE_NOT_ON_VIDEO',
      pass: p.activeVideo === null,
      affects: 'routable',
      detail: p.activeVideo === null ? 'no active Synapse video' : `on Synapse video for ${p.activeVideo.consultId ?? '?'} since ${etClockS(p.activeVideo.startedMs)}`,
      because: p.activeVideo === null ? [] : refs([p.activeVideo.eventId]),
    },
    {
      rule: 'ROUTE_NOT_EXTERNAL_VIDEO',
      pass: ext === undefined,
      affects: 'routable',
      detail: ext === undefined ? 'no external-video signal' : `camera active since ${etClockS(ext.value.sinceMs)} with no Synapse video: treated as busy`,
      because: ext?.because ?? [],
    },
    {
      rule: 'ROUTE_NOT_TEMP_UNAVAILABLE',
      pass: status !== 'Temporarily Unavailable',
      affects: 'routable',
      detail: `self-reported status ${status ?? 'unknown'}`,
      because: p.selfStatus.because,
    },
    {
      rule: 'ROUTE_PHONE_NOT_RINGING',
      pass: ringing === null,
      affects: 'routable',
      detail: ringing === null ? 'phone not ringing for another call' : `phone ringing for ${ringing.consultId ?? '?'} since ${etClockS(ringing.sinceMs)}`,
      because: ringing === null ? [] : refs([ringing.eventId]),
    },
    {
      rule: 'ROUTE_NO_PENDING_FIRST_CONTACT',
      pass: pending.length === 0,
      affects: 'routable',
      inferred: true,
      detail:
        pending.length === 0
          ? 'no assigned consult awaiting first contact'
          : `inferred from data (OQ-23): ${pending.map((c) => c.consultId).join(', ')} assigned, hospital has not reached the physician yet`,
      because: refs(pending.map((c) => c.assignmentHistory.at(-1)?.eventId ?? '')),
    },
    {
      rule: 'ROUTE_CALL_COOLDOWN',
      pass: !coolingDown,
      affects: 'routable',
      detail:
        sinceCallEnd === null
          ? 'no call ended this shift'
          : `last call ended ${etClockS(p.lastCallEndedMs ?? 0)} (${Math.floor(sinceCallEnd / 1000)} s ago; excluded if < ${CALL_COOLDOWN_MS / 1000} s)`,
      because: coolingDown && p.lastCallEndedBy !== null ? [p.lastCallEndedBy] : [],
    },
    {
      rule: 'ROUTE_DOCUMENTING_ALLOWED',
      pass: true,
      affects: 'info',
      detail: documenting.length === 0 ? 'not documenting' : `documenting ${documenting.join(', ')}: not busy for routing (OQ-06)`,
      because: [],
    },
    {
      rule: 'ROUTE_IN_MEETING_ALLOWED',
      pass: true,
      affects: 'info',
      detail: status === 'In Meeting' ? 'In Meeting: interruptible, stays routable' : 'not in a meeting',
      because: status === 'In Meeting' ? p.selfStatus.because : [],
    },
    {
      rule: 'ROUTE_AGENT_VERIFIED',
      pass: p.agent.online,
      affects: 'verified',
      detail: p.agent.online ? 'presence agent online' : `presence agent offline since ${etClockS(p.agent.sinceMs ?? 0)}: routing assumes available, unverified`,
      because: p.agent.online ? [] : p.agent.because,
    },
  ];
}

/** OQ-23: open consults assigned to the physician with no call yet (excluding the consult being routed). */
function pendingFirstContact(state: NetworkState, p: PhysicianState, forConsultId: string | undefined): ConsultState[] {
  return p.openConsultIds
    .filter((id) => id !== forConsultId)
    .map((id) => state.consults[id])
    .filter((c): c is ConsultState => c !== undefined && c.assignedPhysicianId === p.physicianId && c.contactedMs === null);
}

export interface RouteCandidate {
  readonly physicianId: string;
  readonly tier: 'low_volume_priority' | 'fewest_consults';
  readonly consults: number;
  readonly lastAnsweredMs: EpochMs | null;
  readonly dayShift: boolean;
  readonly verified: boolean;
  readonly why: string;
}

export interface RouteChoice {
  readonly hospitalId: string;
  readonly atMs: EpochMs;
  readonly chosen: string | null;
  readonly ranked: readonly RouteCandidate[];
  readonly excluded: readonly { readonly physicianId: string; readonly failedRules: readonly RouteCheck[] }[];
  /** ROUTE_NO_ONE_ELIGIBLE when chosen is null (rule 5), else the winning tier's rule. */
  readonly rule: RuleCode;
}

/** Rules 3-5: low-volume priority, then fewest consults, ties to least recently answered (OQ-26); null = routing failure. */
export function chooseRoute(state: NetworkState, staffing: StaffingModel, hospitalId: string, nowMs: EpochMs, opts: RouteOptions = {}): RouteChoice {
  const candidates = candidatePhysicians(state, staffing, nowMs);
  const ranked: RouteCandidate[] = [];
  const excluded: { physicianId: string; failedRules: RouteCheck[] }[] = [];
  for (const id of candidates) {
    const r = opts.precomputed?.[id] ?? routableNow(state, staffing, id, hospitalId, nowMs, opts);
    if (!r.routable) {
      excluded.push({ physicianId: id, failedRules: r.reasons.filter((x) => x.affects === 'routable' && !x.pass) });
      continue;
    }
    ranked.push(candidate(state, staffing, id, nowMs, r.verified));
  }
  ranked.sort(compareCandidates);
  const top = ranked[0];
  return {
    hospitalId,
    atMs: nowMs,
    chosen: top?.physicianId ?? null,
    ranked,
    excluded,
    rule: top === undefined ? 'ROUTE_NO_ONE_ELIGIBLE' : top.tier === 'low_volume_priority' ? 'ROUTE_LOW_VOLUME_PRIORITY' : 'ROUTE_FEWEST_CONSULTS',
  };
}

/** Everyone the replay tracks plus scheduled arrivals on shift now, in a stable order. */
export function candidatePhysicians(state: NetworkState, staffing: StaffingModel, nowMs: EpochMs): string[] {
  const ids = new Set(Object.keys(state.physicians));
  for (const s of staffing.shifts) if (s.startMs <= nowMs && nowMs < s.endMs) ids.add(s.physicianId);
  return [...ids].sort(compareIds);
}

function candidate(state: NetworkState, staffing: StaffingModel, id: string, nowMs: EpochMs, verified: boolean): RouteCandidate {
  const p = state.physicians[id];
  const consults = p?.consultsThisShift ?? 0;
  const dayShift = shiftOf(staffing, id, nowMs)?.dayShift ?? true;
  const limit = dayShift ? LOW_VOLUME_MAX_CONSULTS.day : LOW_VOLUME_MAX_CONSULTS.night;
  const tier = consults <= limit ? 'low_volume_priority' : 'fewest_consults';
  const lastAnsweredMs = p?.lastAnsweredMs ?? null;
  const answered = lastAnsweredMs === null ? 'never answered' : `last answered ${etClockS(lastAnsweredMs)}`;
  const why =
    tier === 'low_volume_priority'
      ? `low volume: ${consults} consults <= ${limit} (${dayShift ? 'day' : 'night'} shift, rule 3); ${answered}`
      : `${consults} consults this shift (rule 4); ${answered}`;
  return { physicianId: id, tier, consults, lastAnsweredMs, dayShift, verified, why };
}

function compareCandidates(a: RouteCandidate, b: RouteCandidate): number {
  const tier = (c: RouteCandidate) => (c.tier === 'low_volume_priority' ? 0 : 1);
  const answered = (c: RouteCandidate) => c.lastAnsweredMs ?? Number.NEGATIVE_INFINITY;
  return tier(a) - tier(b) || a.consults - b.consults || answered(a) - answered(b) || compareIds(a.physicianId, b.physicianId);
}

export interface DeadlockFinding {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly consultType: ConsultState['consultType'];
  readonly stage: ConsultState['stage'];
  readonly receivedMs: EpochMs | null;
  readonly routingFailures: readonly { readonly atMs: EpochMs; readonly eventId: string }[];
  /** chooseRoute for this consult: chosen is null and ranked is empty. */
  readonly choice: RouteChoice;
  readonly because: readonly EventRef[];
}

/**
 * Open, unassigned consults that no physician can take right now: routing
 * rule 5 ("If nobody is eligible, the routing attempt fails"). Routability is
 * evaluated for the consult itself, so a call already ringing for it is not
 * "another call".
 */
export function findRoutingDeadlocks(state: NetworkState, staffing: StaffingModel, nowMs: EpochMs): DeadlockFinding[] {
  return Object.values(state.consults)
    .filter((c) => c.open && c.assignedPhysicianId === null && c.hospitalId !== null)
    .sort((a, b) => compareIds(a.consultId, b.consultId))
    .flatMap((c) => {
      const choice = chooseRoute(state, staffing, c.hospitalId ?? '', nowMs, { forConsultId: c.consultId });
      if (choice.chosen !== null) return [];
      const failureRefs = c.routingFailures.map((f) => staffing.refs.get(f.eventId)).filter((r): r is EventRef => r !== undefined);
      // Evidence only from physicians who are on shift and credentialed here: they are the ones rule 2 blocks.
      const exclusionRefs = blockingExclusions(choice).flatMap((x) => x.failedRules.flatMap((r) => r.because));
      return [
        {
          consultId: c.consultId,
          hospitalId: c.hospitalId ?? '',
          consultType: c.consultType,
          stage: c.stage,
          receivedMs: c.receivedMs,
          routingFailures: c.routingFailures,
          choice,
          because: dedupeRefs([...failureRefs, ...exclusionRefs]),
        },
      ];
    });
}

export function dedupeRefs(refs: readonly EventRef[]): EventRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.eventId) ? false : (seen.add(r.eventId), true)));
}

/** Excluded physicians who pass rule 1 (on shift, credentialed) and fail only rule 2 checks. */
export function blockingExclusions(choice: RouteChoice): RouteChoice['excluded'] {
  return choice.excluded.filter((x) => !x.failedRules.some((r) => r.rule === 'ROUTE_CREDENTIALED' || r.rule === 'ROUTE_ON_SHIFT'));
}
