import { DateTime } from 'luxon';
import { AT_RISK_MAX_MARGIN, COVERAGE_EXCLUDED_STATUSES, DEMAND_SPIKE_PROJECTION, PROJECTION_HOLDS_CURRENT_STATUS } from '../policy';
import type { RuleCode } from '../replay/rules';
import type { EventRef, NetworkState } from '../replay/types';
import { ET_ZONE, etDateOf, etWallClockToEpoch } from '../time';
import type { CoverageRequirement, Dataset, EpochMs } from '../types';
import type { DemandEvaluation } from './demand';
import { candidatePhysicians, routableNow, type Routability } from './routing';
import { etClock, shiftCountsAt, shiftsAt, type StaffingModel } from './staffing';

/**
 * Staffed-capacity coverage (OQ-24(a)): brief "Coverage and Split-Shift
 * Eligibility" ("a minimum number of available, credentialed physicians per
 * time block ... A gap exists when that number is not met, either now or at a
 * projected time"). Routable-now counts are reported alongside, never mixed in.
 */

export interface HospitalCoverageAt {
  readonly blockMinimum: number;
  /** +1 while the hospital is in a demand spike (OQ-19: held from now through the horizon). */
  readonly spikeAdd: number;
  readonly required: number;
  readonly staffed: number;
  readonly staffedIds: readonly string[];
  /** OQ-29: counted from the roster or a confirmed arrival. staffed = staffedConfirmed + staffedExpected. */
  readonly staffedConfirmed: number;
  /** OQ-29: counted only because an arrival or offer is expected (no shift_started known yet). */
  readonly staffedExpected: number;
  readonly expectedIds: readonly string[];
  /** Counted but agent offline (OQ-02). */
  readonly unverifiedIds: readonly string[];
  /** Counted because a scheduled shift has started (OQ-27). */
  readonly scheduledArrivalIds: readonly string[];
  /** On shift and credentialed but not counted: Temporarily Unavailable (OQ-28). */
  readonly tempUnavailableIds: readonly string[];
}

export interface CoveragePoint {
  readonly tMs: EpochMs;
  readonly perHospital: Readonly<Record<string, HospitalCoverageAt>>;
}

export interface CoverageCause {
  readonly kind: 'shift_end' | 'spike' | 'temp_unavailable' | 'block_change';
  readonly physicianId?: string;
  readonly atMs: EpochMs;
  readonly detail: string;
  readonly rule: RuleCode;
  readonly because: readonly EventRef[];
}

export interface CoverageGap {
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly startMs: EpochMs;
  readonly endMs: EpochMs | 'beyond_horizon';
  readonly required: number;
  readonly staffed: number;
  readonly staffedConfirmed: number;
  readonly staffedExpected: number;
  readonly shortfall: number;
  readonly maxShortfall: number;
  readonly causes: readonly CoverageCause[];
  readonly whoRemains: readonly string[];
  readonly rule: RuleCode;
}

export type CoverageStatus = 'OK' | 'AT_RISK' | 'HARD_GAP';

/** A merged run of timeline points with the same non-OK status at one hospital (OQ-29). */
export interface CoverageInterval {
  readonly hospitalId: string;
  readonly hospitalName: string;
  /** HARD_GAP: confirmed + expected < required. AT_RISK: met only via expected arrivals, margin <= AT_RISK_MAX_MARGIN. */
  readonly status: 'AT_RISK' | 'HARD_GAP';
  readonly startMs: EpochMs;
  readonly endMs: EpochMs | 'beyond_horizon';
  readonly required: number;
  readonly staffedConfirmed: number;
  readonly staffedExpected: number;
  readonly expectedIds: readonly string[];
  readonly staffedIds: readonly string[];
  readonly rule: RuleCode;
}

export interface CoverageProjection {
  readonly nowMs: EpochMs;
  readonly horizonEndMs: EpochMs;
  readonly timeline: readonly CoveragePoint[];
  readonly timelineExcludingArrivals: readonly CoveragePoint[];
  readonly gaps: readonly CoverageGap[];
  readonly gapsExcludingArrivals: readonly CoverageGap[];
  /** OQ-29 classification of the default timeline: every HARD_GAP and AT_RISK interval. */
  readonly classification: readonly CoverageInterval[];
  /** Routing rules 1-2 now (OQ-24(b)): count and ids of routable credentialed physicians per hospital. */
  readonly routableNow: Readonly<Record<string, number>>;
  readonly routableNowIds: Readonly<Record<string, readonly string[]>>;
}

export interface ProjectionOptions {
  readonly horizonMin: number;
  readonly stepMin: number;
}

export function projectCoverage(
  dataset: Dataset,
  state: NetworkState,
  staffing: StaffingModel,
  demand: readonly DemandEvaluation[],
  nowMs: EpochMs,
  opts: ProjectionOptions,
  routability?: Readonly<Record<string, Readonly<Record<string, Routability>>>>,
): CoverageProjection {
  const horizonEndMs = nowMs + opts.horizonMin * 60_000;
  const times = timelineTimes(dataset, staffing, nowMs, horizonEndMs, opts.stepMin);
  const spiking = new Set(demand.filter((d) => d.spike && DEMAND_SPIKE_PROJECTION === 'hold_from_now_through_horizon').map((d) => d.hospitalId));
  const build = (includeArrivals: boolean) => times.map((t) => pointAt(dataset, state, staffing, spiking, t, includeArrivals));
  const timeline = build(true);
  const timelineExcludingArrivals = build(false);
  const demandById = new Map(demand.map((d) => [d.hospitalId, d]));
  const routable = routableCounts(state, staffing, nowMs, routability);
  return {
    nowMs,
    horizonEndMs,
    timeline,
    timelineExcludingArrivals,
    gaps: findGaps(dataset, state, staffing, timeline, demandById),
    gapsExcludingArrivals: findGaps(dataset, state, staffing, timelineExcludingArrivals, demandById),
    classification: classifyCoverage(dataset, timeline),
    routableNow: Object.fromEntries(Object.entries(routable).map(([h, ids]) => [h, ids.length])),
    routableNowIds: routable,
  };
}

/** Grid points every stepMin plus every exact boundary (shift ends/starts, coverage block edges) in the horizon. */
function timelineTimes(dataset: Dataset, staffing: StaffingModel, nowMs: EpochMs, endMs: EpochMs, stepMin: number): EpochMs[] {
  const times = new Set<EpochMs>();
  for (let t = nowMs; t <= endMs; t += stepMin * 60_000) times.add(t);
  times.add(endMs);
  for (const s of staffing.shifts) for (const b of [s.startMs, s.endMs]) if (b > nowMs && b <= endMs) times.add(b);
  const edges = new Set(dataset.coverageRequirements.flatMap((c) => [c.timeBlockEt.start.secondOfDay, c.timeBlockEt.end.secondOfDay]));
  const today = etDateOf(nowMs);
  const tomorrow = DateTime.fromISO(today, { zone: ET_ZONE }).plus({ days: 1 }).toISODate() ?? today;
  for (const date of [today, tomorrow]) {
    for (const sec of edges) {
      const b = etWallClockToEpoch(date, sec);
      if (b > nowMs && b <= endMs) times.add(b);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** OQ-01: ET blocks, start-inclusive, end-exclusive, wrapping midnight when end < start. `sod` = ET second of day. */
function blockMinimum(dataset: Dataset, hospitalId: string, sod: number): { minimum: number; block: CoverageRequirement | null } {
  const block = dataset.coverageRequirements.find((c) => {
    if (c.hospitalId !== hospitalId) return false;
    const { start, end, wrapsMidnight } = c.timeBlockEt;
    return wrapsMidnight ? sod >= start.secondOfDay || sod < end.secondOfDay : sod >= start.secondOfDay && sod < end.secondOfDay;
  });
  return { minimum: block?.minAvailableCredentialedPhysicians ?? 0, block: block ?? null };
}

function pointAt(dataset: Dataset, state: NetworkState, staffing: StaffingModel, spiking: ReadonlySet<string>, t: EpochMs, includeArrivals: boolean): CoveragePoint {
  const onShift = shiftsAt(staffing, t, includeArrivals);
  const local = DateTime.fromMillis(t, { zone: ET_ZONE });
  const sod = local.hour * 3600 + local.minute * 60 + local.second;
  const perHospital: Record<string, HospitalCoverageAt> = {};
  for (const h of dataset.hospitals) {
    const credentialed = onShift.filter((s) => shiftCountsAt(staffing, s, h.hospitalId));
    const excluded = credentialed.filter((s) => isExcludedByStatus(state, s.physicianId));
    const counted = credentialed.filter((s) => !isExcludedByStatus(state, s.physicianId));
    const expected = counted.filter((s) => s.confirmation === 'expected');
    const blockMin = blockMinimum(dataset, h.hospitalId, sod).minimum;
    const spikeAdd = spiking.has(h.hospitalId) ? 1 : 0;
    perHospital[h.hospitalId] = {
      blockMinimum: blockMin,
      spikeAdd,
      required: blockMin + spikeAdd,
      staffed: counted.length,
      staffedIds: counted.map((s) => s.physicianId),
      staffedConfirmed: counted.length - expected.length,
      staffedExpected: expected.length,
      expectedIds: expected.map((s) => s.physicianId),
      unverifiedIds: counted.filter((s) => state.physicians[s.physicianId]?.agent.online === false).map((s) => s.physicianId),
      scheduledArrivalIds: counted.filter((s) => s.source === 'scheduled_arrival').map((s) => s.physicianId),
      tempUnavailableIds: excluded.map((s) => s.physicianId),
    };
  }
  return { tMs: t, perHospital };
}

/** OQ-02 / OQ-28: the current self-reported status persists through the projection. */
function isExcludedByStatus(state: NetworkState, physicianId: string): boolean {
  if (!PROJECTION_HOLDS_CURRENT_STATUS) return false;
  const status = state.physicians[physicianId]?.selfStatus.value ?? null;
  return status !== null && COVERAGE_EXCLUDED_STATUSES.includes(status);
}

function findGaps(
  dataset: Dataset,
  state: NetworkState,
  staffing: StaffingModel,
  timeline: readonly CoveragePoint[],
  demandById: ReadonlyMap<string, DemandEvaluation>,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const h of dataset.hospitals) {
    let i = 0;
    while (i < timeline.length) {
      const at = timeline[i]?.perHospital[h.hospitalId];
      if (at === undefined || at.staffed >= at.required) {
        i++;
        continue;
      }
      const startIdx = i;
      let maxShortfall = 0;
      while (i < timeline.length) {
        const cur = timeline[i]?.perHospital[h.hospitalId];
        if (cur === undefined || cur.staffed >= cur.required) break;
        maxShortfall = Math.max(maxShortfall, cur.required - cur.staffed);
        i++;
      }
      const start = timeline[startIdx];
      const startAt = start?.perHospital[h.hospitalId];
      if (start === undefined || startAt === undefined) continue;
      gaps.push({
        hospitalId: h.hospitalId,
        hospitalName: h.hospitalName,
        startMs: start.tMs,
        endMs: timeline[i]?.tMs ?? 'beyond_horizon',
        required: startAt.required,
        staffed: startAt.staffed,
        staffedConfirmed: startAt.staffedConfirmed,
        staffedExpected: startAt.staffedExpected,
        shortfall: startAt.required - startAt.staffed,
        maxShortfall,
        causes: gapCauses(state, staffing, timeline[startIdx - 1], start, h.hospitalId, demandById.get(h.hospitalId)),
        whoRemains: startAt.staffedIds,
        rule: 'COVERAGE_STAFFED_CAPACITY',
      });
    }
  }
  return gaps.sort((a, b) => a.startMs - b.startMs || (a.hospitalId < b.hospitalId ? -1 : 1));
}

function gapCauses(
  state: NetworkState,
  staffing: StaffingModel,
  prev: CoveragePoint | undefined,
  start: CoveragePoint,
  hospitalId: string,
  demand: DemandEvaluation | undefined,
): CoverageCause[] {
  const at = start.perHospital[hospitalId];
  if (at === undefined) return [];
  const before = prev?.perHospital[hospitalId];
  const causes: CoverageCause[] = [];
  for (const id of before?.staffedIds ?? []) {
    if (at.staffedIds.includes(id)) continue;
    const shift = staffing.shifts.find((s) => s.physicianId === id && s.endMs === start.tMs);
    const by = state.physicians[id]?.shiftStartedBy;
    causes.push({
      kind: 'shift_end',
      physicianId: id,
      atMs: shift?.endMs ?? start.tMs,
      detail: `${id} shift ends ${etClock(shift?.endMs ?? start.tMs)} ET`,
      rule: 'COVERAGE_SHIFT_END',
      because: by ? [by] : [],
    });
  }
  if (before !== undefined && at.blockMinimum > before.blockMinimum) {
    causes.push({ kind: 'block_change', atMs: start.tMs, detail: `block minimum rises ${before.blockMinimum} -> ${at.blockMinimum} at ${etClock(start.tMs)} ET`, rule: 'COVERAGE_BLOCK_CHANGE', because: [] });
  }
  if (at.spikeAdd > 0) {
    causes.push({
      kind: 'spike',
      atMs: start.tMs,
      detail: `demand spike adds +1: ${demand?.count ?? '?'} consults in 60 min vs p90 ${demand?.p90 ?? '?'}`,
      rule: 'DEMAND_SPIKE_TRAILING_60',
      because: demand?.because ?? [],
    });
  }
  for (const id of at.tempUnavailableIds) {
    causes.push({ kind: 'temp_unavailable', physicianId: id, atMs: start.tMs, detail: `${id} is Temporarily Unavailable (held, OQ-28)`, rule: 'COVERAGE_STAFFED_CAPACITY', because: state.physicians[id]?.selfStatus.because ?? [] });
  }
  return causes;
}

function routableCounts(
  state: NetworkState,
  staffing: StaffingModel,
  nowMs: EpochMs,
  routability: Readonly<Record<string, Readonly<Record<string, Routability>>>> | undefined,
): Record<string, string[]> {
  const ids = candidatePhysicians(state, staffing, nowMs);
  const out: Record<string, string[]> = {};
  for (const h of staffing.hospitals) {
    out[h.hospitalId] = ids.filter((p) => (routability?.[h.hospitalId]?.[p] ?? routableNow(state, staffing, p, h.hospitalId, nowMs)).routable);
  }
  return out;
}

/** OQ-29: HARD_GAP when confirmed + expected < required; AT_RISK when met only via expected arrivals with margin <= AT_RISK_MAX_MARGIN. */
export function coverageStatus(x: HospitalCoverageAt): CoverageStatus {
  if (x.staffed < x.required) return 'HARD_GAP';
  if (x.staffedConfirmed < x.required && x.staffed - x.required <= AT_RISK_MAX_MARGIN) return 'AT_RISK';
  return 'OK';
}

function classifyCoverage(dataset: Dataset, timeline: readonly CoveragePoint[]): CoverageInterval[] {
  const out: CoverageInterval[] = [];
  for (const h of dataset.hospitals) {
    let i = 0;
    while (i < timeline.length) {
      const at = timeline[i]?.perHospital[h.hospitalId];
      const status = at === undefined ? 'OK' : coverageStatus(at);
      if (at === undefined || status === 'OK') {
        i++;
        continue;
      }
      const start = timeline[i];
      while (i < timeline.length) {
        const cur = timeline[i]?.perHospital[h.hospitalId];
        if (cur === undefined || coverageStatus(cur) !== status) break;
        i++;
      }
      if (start === undefined) continue;
      out.push({
        hospitalId: h.hospitalId,
        hospitalName: h.hospitalName,
        status,
        startMs: start.tMs,
        endMs: timeline[i]?.tMs ?? 'beyond_horizon',
        required: at.required,
        staffedConfirmed: at.staffedConfirmed,
        staffedExpected: at.staffedExpected,
        expectedIds: at.expectedIds,
        staffedIds: at.staffedIds,
        // Numbers are those at the interval start; AT_RISK exists only because of OQ-29 arrival confirmation.
        rule: status === 'AT_RISK' ? 'COVERAGE_ARRIVAL_CONFIRMATION' : 'COVERAGE_STAFFED_CAPACITY',
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || (a.hospitalId < b.hospitalId ? -1 : 1));
}

/** Causes for a status change at `startMs` (compared with the previous timeline point), for gaps and AT_RISK intervals. */
export function intervalCauses(
  state: NetworkState,
  staffing: StaffingModel,
  timeline: readonly CoveragePoint[],
  startMs: EpochMs,
  hospitalId: string,
  demand: DemandEvaluation | undefined,
): CoverageCause[] {
  const idx = timeline.findIndex((p) => p.tMs === startMs);
  const start = timeline[idx];
  return start === undefined ? [] : gapCauses(state, staffing, timeline[idx - 1], start, hospitalId, demand);
}
