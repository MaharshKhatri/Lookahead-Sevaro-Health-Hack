import { DateTime } from 'luxon';
import { ARRIVAL_CONFIRMATION_EARLY_TOLERANCE_MIN, DAY_SHIFT_START_WINDOW_ET, SCHEDULED_ARRIVALS_COUNT_AS_ON_SHIFT, SCHEDULED_SHIFT_HOURS } from '../policy';
import type { EventRef, NetworkState } from '../replay/types';
import { ET_ZONE } from '../time';
import type { Dataset, EpochMs, Hospital } from '../types';

/**
 * A shift window: from the on-shift roster (via replay), a scheduled arrival
 * from the off-shift roster (OQ-27), or an accepted split-shift offer (what-if).
 */
export interface ScheduledShift {
  readonly physicianId: string;
  readonly name: string | null;
  readonly startMs: EpochMs;
  readonly endMs: EpochMs;
  readonly source: 'on_shift_roster' | 'scheduled_arrival' | 'split_shift_offer';
  /** OQ-10: starts in [06:00, 18:00) ET. */
  readonly dayShift: boolean;
  /**
   * OQ-29: roster shifts are facts; arrivals and offers stay 'expected' until a
   * shift_started for the physician is known at/after the scheduled start.
   */
  readonly confirmation: 'roster' | 'confirmed' | 'expected';
  readonly confirmedBy: EventRef | null;
  /** Split-shift trap mitigation SCOPE (OQ-35): counts and routes only at these hospitals; null = all credentialed. */
  readonly scopeHospitalIds: readonly string[] | null;
  /** Split-shift trap mitigation SEED (OQ-35): added to consults this shift for routing rules 3-4. */
  readonly seededConsults: number;
}

/**
 * An accepted split-shift offer as staffing sees it (brief "Act": "update
 * projected coverage when someone accepts"). Scope and seed are the OQ-35
 * trap mitigations frozen into the offer.
 */
export interface AcceptedOffer {
  readonly physicianId: string;
  readonly name: string | null;
  readonly startMs: EpochMs;
  readonly endMs: EpochMs;
  readonly scopeHospitalIds: readonly string[];
  readonly seededConsultCount: number;
}

/** Static facts detection needs beside the replay state. Built once per detect() call. */
export interface StaffingModel {
  readonly credentials: ReadonlyMap<string, ReadonlySet<string>>;
  readonly shifts: readonly ScheduledShift[];
  readonly hospitals: readonly Hospital[];
  readonly hospitalNames: ReadonlyMap<string, string>;
  readonly physicianNames: ReadonlyMap<string, string>;
  /** event_id -> reference, for provenance of facts the replay stores by id. */
  readonly refs: ReadonlyMap<string, EventRef>;
}

export function buildStaffingModel(dataset: Dataset, state: NetworkState): StaffingModel {
  const credentials = new Map(dataset.credentials.map((c) => [c.physicianId, new Set(c.credentialedHospitalIds)]));
  const roster: ScheduledShift[] = Object.values(state.physicians)
    .filter((p) => p.onRoster && p.shift !== null)
    .map((p) => ({
      physicianId: p.physicianId,
      name: p.name,
      startMs: p.shift?.startMs ?? 0,
      endMs: p.shift?.endMs ?? 0,
      source: 'on_shift_roster',
      dayShift: isDayShift(p.shift?.startMs ?? 0),
      confirmation: 'roster',
      confirmedBy: p.shiftStartedBy,
      scopeHospitalIds: null,
      seededConsults: 0,
    }));
  const arrivals: ScheduledShift[] = SCHEDULED_ARRIVALS_COUNT_AS_ON_SHIFT
    ? dataset.offShiftRoster.map((r) => {
        const confirmedBy = confirmationEvent(state, r.physicianId, r.nextShiftStart);
        return {
          physicianId: r.physicianId,
          name: r.name,
          startMs: r.nextShiftStart,
          endMs: r.nextShiftStart + SCHEDULED_SHIFT_HOURS * 3_600_000,
          source: 'scheduled_arrival',
          dayShift: isDayShift(r.nextShiftStart),
          confirmation: confirmedBy === null ? 'expected' : 'confirmed',
          confirmedBy,
          scopeHospitalIds: null,
          seededConsults: 0,
        };
      })
    : [];
  const refs = new Map<string, EventRef>();
  for (const e of dataset.events) if (!refs.has(e.eventId)) refs.set(e.eventId, { eventId: e.eventId, eventTimeMs: e.eventTime, eventType: e.eventType });
  const physicianNames = new Map<string, string>();
  for (const p of [...dataset.credentials, ...dataset.offShiftRoster, ...dataset.physiciansOnShift]) physicianNames.set(p.physicianId, p.name);
  return {
    credentials,
    shifts: [...roster, ...arrivals],
    hospitals: dataset.hospitals,
    hospitalNames: new Map(dataset.hospitals.map((h) => [h.hospitalId, h.hospitalName])),
    physicianNames,
    refs,
  };
}

/**
 * OQ-29: the shift_started event that confirms an expected arrival: known at
 * the replay's knowledge time and dated at/after the scheduled start (minus
 * the policy tolerance). Null while the arrival is only expected.
 */
export function confirmationEvent(state: NetworkState, physicianId: string, scheduledStartMs: EpochMs): EventRef | null {
  const by = state.physicians[physicianId]?.shiftStartedBy ?? null;
  return by !== null && by.eventTimeMs >= scheduledStartMs - ARRIVAL_CONFIRMATION_EARLY_TOLERANCE_MIN * 60_000 ? by : null;
}

/** A shift counts at a hospital when the physician is credentialed there and (if scoped) the hospital is in scope. */
export function shiftCountsAt(model: StaffingModel, shift: ScheduledShift, hospitalId: string): boolean {
  return isCredentialed(model, shift.physicianId, hospitalId) && (shift.scopeHospitalIds === null || shift.scopeHospitalIds.includes(hospitalId));
}

/** A copy of the model with extra shifts (e.g. accepted split-shift offers for a what-if). Pure. */
export function withShifts(model: StaffingModel, extra: readonly ScheduledShift[]): StaffingModel {
  return { ...model, shifts: [...model.shifts, ...extra] };
}

/** OQ-10: a shift that starts in [06:00, 18:00) ET is a day shift. */
export function isDayShift(startMs: EpochMs): boolean {
  const dt = DateTime.fromMillis(startMs, { zone: ET_ZONE });
  const sod = dt.hour * 3600 + dt.minute * 60 + dt.second;
  return sod >= DAY_SHIFT_START_WINDOW_ET.startSecondOfDay && sod < DAY_SHIFT_START_WINDOW_ET.endSecondOfDay;
}

/** Shifts covering instant t (half-open [start, end), OQ-21), optionally without scheduled arrivals. */
export function shiftsAt(model: StaffingModel, t: EpochMs, includeArrivals = true): ScheduledShift[] {
  return model.shifts.filter((s) => s.startMs <= t && t < s.endMs && (includeArrivals || s.source !== 'scheduled_arrival'));
}

export function shiftOf(model: StaffingModel, physicianId: string, t: EpochMs, includeArrivals = true): ScheduledShift | null {
  return shiftsAt(model, t, includeArrivals).find((s) => s.physicianId === physicianId) ?? null;
}

export function isCredentialed(model: StaffingModel, physicianId: string, hospitalId: string): boolean {
  return model.credentials.get(physicianId)?.has(hospitalId) ?? false;
}

/** ET wall-clock labels for explanations. Memoized: the same instants are formatted many times per detect() call. */
const clockCache = new Map<string, string>();
function formatEt(ms: EpochMs, fmt: 'HH:mm' | 'HH:mm:ss'): string {
  const key = `${fmt}|${ms}`;
  let out = clockCache.get(key);
  if (out === undefined) {
    if (clockCache.size > 50_000) clockCache.clear();
    out = DateTime.fromMillis(ms, { zone: ET_ZONE }).toFormat(fmt);
    clockCache.set(key, out);
  }
  return out;
}
export const etClock = (ms: EpochMs): string => formatEt(ms, 'HH:mm');
export const etClockS = (ms: EpochMs): string => formatEt(ms, 'HH:mm:ss');
export const minutes = (ms: number): string => (ms / 60_000).toFixed(1).replace(/\.0$/, '');

/** The shift an accepted offer adds: expected until a shift_started at/after its start is known (OQ-29). */
export function offerShift(state: NetworkState, o: AcceptedOffer): ScheduledShift {
  const confirmedBy = confirmationEvent(state, o.physicianId, o.startMs);
  return {
    physicianId: o.physicianId,
    name: o.name,
    startMs: o.startMs,
    endMs: o.endMs,
    source: 'split_shift_offer',
    dayShift: isDayShift(o.startMs),
    confirmation: confirmedBy === null ? 'expected' : 'confirmed',
    confirmedBy,
    scopeHospitalIds: o.scopeHospitalIds,
    seededConsults: o.seededConsultCount,
  };
}
