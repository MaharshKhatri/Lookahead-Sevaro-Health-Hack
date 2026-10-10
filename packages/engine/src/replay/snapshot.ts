import { DateTime } from 'luxon';
import { SNAPSHOT_UNASSIGNED } from '../data/parse';
import { columnsOf, snapshotOpenConsultsSchema, snapshotPhysiciansSchema } from '../data/schemas';
import { ET_ZONE, etDateOf, etWallClockToEpoch } from '../time';
import type { Dataset, EpochMs, Snapshot } from '../types';
import { compareIds } from './derive';
import type { NetworkState } from './types';

/** Snapshot rows keyed by the exact CSV column names, cells formatted as in the files. */
export type SnapshotPhysicianCsvRow = Readonly<Record<keyof typeof snapshotPhysiciansSchema.shape, string>>;
export type SnapshotConsultCsvRow = Readonly<Record<keyof typeof snapshotOpenConsultsSchema.shape, string>>;

export const SNAPSHOT_PHYSICIAN_COLUMNS = columnsOf(snapshotPhysiciansSchema);
export const SNAPSHOT_CONSULT_COLUMNS = columnsOf(snapshotOpenConsultsSchema);

/** Values of snapshot_physicians.desktop_agent. */
const DESKTOP_AGENT_ONLINE = 'Online';
const DESKTOP_AGENT_OFFLINE = 'Offline';

const etClock = (ms: EpochMs, fmt: 'HH:mm' | 'HH:mm:ss') => DateTime.fromMillis(ms, { zone: ET_ZONE }).toFormat(fmt);
const floorMinutes = (ms: number) => Math.floor(ms / 60_000);

/**
 * The reference "now": the snapshot file label (HHMM) as ET wall-clock on the
 * ET date of the latest event (OQ-13). Null when there is no HHMM snapshot.
 */
export function snapshotAsOfMs(dataset: Dataset): EpochMs | null {
  const m = dataset.snapshot === null ? null : /^(\d{2})(\d{2})$/.exec(dataset.snapshot.label);
  if (m === null || dataset.events.length === 0) return null;
  const latest = dataset.events.reduce((a, e) => Math.max(a, e.eventTime), Number.NEGATIVE_INFINITY);
  return etWallClockToEpoch(etDateOf(latest), Number(m[1]) * 3600 + Number(m[2]) * 60);
}

/** One row per rostered physician, in roster order. Derivations: docs/DATA_PROFILE.md (8/8 in recon). */
export function toSnapshotPhysicianRows(state: NetworkState): SnapshotPhysicianCsvRow[] {
  return Object.values(state.physicians)
    .filter((p) => p.onRoster)
    .map((p) => ({
      physician_id: p.physicianId,
      name: p.name ?? '',
      shift_et: p.shift === null ? '' : `${etClock(p.shift.startMs, 'HH:mm')}-${etClock(p.shift.endMs, 'HH:mm')}`,
      self_reported_status: p.selfStatus.value ?? '',
      desktop_agent: p.agent.online ? DESKTOP_AGENT_ONLINE : DESKTOP_AGENT_OFFLINE,
      derived_state: p.derivedState.value,
      consults_this_shift: String(p.consultsThisShift),
      calls_this_shift: String(p.callsThisShift),
      open_consults: String(p.openConsultIds.length),
      minutes_to_shift_end: p.shift === null ? '' : String(floorMinutes(p.shift.endMs - state.asOfMs)),
    }));
}

/** One row per open consult, ordered by consult id. Derivations: docs/DATA_PROFILE.md (18/18 in recon). */
export function toSnapshotConsultRows(state: NetworkState): SnapshotConsultCsvRow[] {
  return Object.values(state.consults)
    .filter((c) => c.open)
    .sort((a, b) => compareIds(a.consultId, b.consultId))
    .map((c) => ({
      consult_id: c.consultId,
      hospital_id: c.hospitalId ?? '',
      hospital_name: c.hospitalName ?? '',
      physician_id: c.assignedPhysicianId ?? SNAPSHOT_UNASSIGNED,
      consult_type: c.consultType ?? '',
      current_stage: c.stage ?? '',
      stage_entered_at: c.stageEnteredMs === null ? '' : etClock(c.stageEnteredMs, 'HH:mm:ss'),
      minutes_in_stage: c.stageEnteredMs === null ? '' : String(floorMinutes(state.asOfMs - c.stageEnteredMs)),
      minutes_since_received: c.receivedMs === null ? '' : String(floorMinutes(state.asOfMs - c.receivedMs)),
    }));
}

/** The loaded reference snapshot, re-expressed as file-formatted cells. */
export function referenceSnapshotRows(snapshot: Snapshot): { physicians: SnapshotPhysicianCsvRow[]; consults: SnapshotConsultCsvRow[] } {
  return {
    physicians: snapshot.physicians.map((r) => ({
      physician_id: r.physicianId,
      name: r.name,
      shift_et: r.shiftEt.raw,
      self_reported_status: r.selfReportedStatus,
      desktop_agent: r.desktopAgent,
      derived_state: r.derivedState,
      consults_this_shift: String(r.consultsThisShift),
      calls_this_shift: String(r.callsThisShift),
      open_consults: String(r.openConsults),
      minutes_to_shift_end: String(r.minutesToShiftEnd),
    })),
    consults: snapshot.consults.map((r) => ({
      consult_id: r.consultId,
      hospital_id: r.hospitalId,
      hospital_name: r.hospitalName,
      physician_id: r.physicianId ?? SNAPSHOT_UNASSIGNED,
      consult_type: r.consultType,
      current_stage: r.currentStage,
      stage_entered_at: r.stageEnteredAt.raw,
      minutes_in_stage: String(r.minutesInStage),
      minutes_since_received: String(r.minutesSinceReceived),
    })),
  };
}

export interface CellDiff {
  readonly table: 'physicians' | 'consults';
  readonly key: string;
  /** Column name, or "*" when the whole row is missing or unexpected. */
  readonly column: string;
  readonly expected: string;
  readonly actual: string;
}

export interface SnapshotDiff {
  readonly diffs: readonly CellDiff[];
  readonly summary: { readonly physicians: string; readonly consults: string };
}

/** Cell-level comparison of computed rows against the reference snapshot rows. */
export function diffSnapshot(
  computed: { readonly physicians: readonly SnapshotPhysicianCsvRow[]; readonly consults: readonly SnapshotConsultCsvRow[] },
  reference: Snapshot,
): SnapshotDiff {
  const ref = referenceSnapshotRows(reference);
  const p = diffTable('physicians', 'physician_id', SNAPSHOT_PHYSICIAN_COLUMNS, computed.physicians, ref.physicians);
  const c = diffTable('consults', 'consult_id', SNAPSHOT_CONSULT_COLUMNS, computed.consults, ref.consults);
  return { diffs: [...p.diffs, ...c.diffs], summary: { physicians: p.summary, consults: c.summary } };
}

function diffTable(
  table: CellDiff['table'],
  keyColumn: string,
  columns: readonly string[],
  computed: readonly Readonly<Record<string, string>>[],
  reference: readonly Readonly<Record<string, string>>[],
): { diffs: CellDiff[]; summary: string } {
  const byKey = new Map(computed.map((r) => [r[keyColumn] ?? '', r]));
  const diffs: CellDiff[] = [];
  let matching = 0;
  for (const exp of reference) {
    const key = exp[keyColumn] ?? '';
    const act = byKey.get(key);
    if (act === undefined) {
      diffs.push({ table, key, column: '*', expected: 'row present', actual: 'row missing' });
      continue;
    }
    const rowDiffs = columns
      .filter((col) => (exp[col] ?? '') !== (act[col] ?? ''))
      .map((col) => ({ table, key, column: col, expected: exp[col] ?? '', actual: act[col] ?? '' }));
    if (rowDiffs.length === 0) matching++;
    diffs.push(...rowDiffs);
  }
  const refKeys = new Set(reference.map((r) => r[keyColumn] ?? ''));
  const extra = computed.filter((r) => !refKeys.has(r[keyColumn] ?? ''));
  for (const r of extra) diffs.push({ table, key: r[keyColumn] ?? '', column: '*', expected: 'row absent', actual: 'row present' });
  const extraNote = extra.length > 0 ? `, ${extra.length} unexpected row(s)` : '';
  return { diffs, summary: `${matching}/${reference.length} rows match${extraNote}` };
}
