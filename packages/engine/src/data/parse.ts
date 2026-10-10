import type { z } from 'zod';
import type { Dataset, DatasetFileNames, RowSource, Snapshot } from '../types';
import { readCsvText, type CsvTable } from './csv';
import { DataParseError } from './errors';
import { integrityWarnings } from './integrity';
import {
  baselineHourlySchema,
  columnsOf,
  coverageRequirementsSchema,
  credentialingFixedSchema,
  credentialingSchema,
  eventStreamSchema,
  hospitalsSchema,
  offShiftRosterSchema,
  physiciansOnShiftSchema,
  snapshotOpenConsultsSchema,
  snapshotPhysiciansSchema,
} from './schemas';

/** Required file names, as listed in brief "Synthetic Dataset". */
export const DATASET_FILES = {
  events: 'event_stream.csv',
  hospitals: 'hospitals.csv',
  physiciansOnShift: 'physicians_on_shift.csv',
  offShiftRoster: 'physicians_off_shift_roster.csv',
  credentials: 'credentialing_matrix.csv',
  baselineHourly: 'baseline_hourly_volume.csv',
  coverageRequirements: 'coverage_requirements.csv',
} as const;

/** Brief names the reference state "snapshot_*_1820.csv"; the package ships these two. */
const SNAPSHOT_PHYSICIANS_FILE = /^snapshot_physicians_(.+)\.csv$/;
const SNAPSHOT_CONSULTS_FILE = /^snapshot_open_consults_(.+)\.csv$/;

/** Value of snapshot_open_consults.physician_id for a consult with no physician. Mapped to null. */
export const SNAPSHOT_UNASSIGNED = 'Unassigned';

/** File name -> file text. Pure input so the same parser serves Node and the browser. */
export type DatasetTexts = Readonly<Record<string, string>>;

/**
 * Parses a full data package. Throws DataParseError (file + line) on any row
 * that does not parse; never drops rows. Non-fatal findings go to `warnings`.
 */
export function parseDataset(texts: DatasetTexts): Dataset {
  const warnings: string[] = [];
  const missing = Object.values(DATASET_FILES).filter((f) => texts[f] === undefined);
  if (missing.length > 0) throw new DataParseError('dataset', null, `missing required file(s): ${missing.join(', ')}`);

  const snapshotPhysicians = findOne(Object.keys(texts), SNAPSHOT_PHYSICIANS_FILE);
  const snapshotConsults = findOne(Object.keys(texts), SNAPSHOT_CONSULTS_FILE);
  const files: DatasetFileNames = { ...DATASET_FILES, snapshotPhysicians, snapshotConsults };
  const recognised = new Set(Object.values(files).filter((f): f is string => f !== null));
  for (const name of Object.keys(texts).sort()) {
    if (!recognised.has(name)) warnings.push(`${name}: not a recognised dataset file; ignored`);
  }

  const table = (name: string): CsvTable => {
    const t = readCsvText(name, texts[name] ?? '');
    if (t.blankLines > 0) warnings.push(`${name}: ${t.blankLines} blank line(s) skipped`);
    return t;
  };

  const events = parseRows(table(files.events), eventStreamSchema, warnings, (r, src, raw) => ({
    ...src,
    eventId: r.event_id,
    eventTime: r.event_time,
    eventTimeRaw: (raw.event_time ?? '').trim(),
    ingestedAt: r.ingested_at,
    ingestedAtRaw: (raw.ingested_at ?? '').trim(),
    consultId: r.consult_id,
    eventType: r.event_type,
    physicianId: r.physician_id,
    hospitalId: r.hospital_id,
    description: r.description,
  }));

  const hospitals = parseRows(table(files.hospitals), hospitalsSchema, warnings, (r, src) => ({
    ...src,
    hospitalId: r.hospital_id,
    hospitalName: r.hospital_name,
    localTimezone: r.local_timezone,
    coverageTier: r.coverage_tier,
  }));

  const physiciansOnShift = parseRows(table(files.physiciansOnShift), physiciansOnShiftSchema, warnings, (r, src) => ({
    ...src,
    physicianId: r.physician_id,
    name: r.name,
    shiftStartEt: r.shift_start_et,
    shiftEndEt: r.shift_end_et,
    splitShiftOptIn: r.split_shift_opt_in,
  }));

  const offShiftRoster = parseRows(table(files.offShiftRoster), offShiftRosterSchema, warnings, (r, src, raw) => ({
    ...src,
    physicianId: r.physician_id,
    name: r.name,
    role: r.role,
    splitShiftOptIn: r.split_shift_opt_in,
    lastShiftEnd: r.last_shift_end,
    lastShiftEndRaw: (raw.last_shift_end ?? '').trim(),
    nextShiftStart: r.next_shift_start,
    nextShiftStartRaw: (raw.next_shift_start ?? '').trim(),
    hoursWorkedLast7d: r.hours_worked_last_7d,
    estMinutesToOnline: r.est_minutes_to_online,
    preferredChannel: r.preferred_channel,
    offersDeclinedLast30d: r.offers_declined_last_30d,
  }));

  const credTable = table(files.credentials);
  const fixed = columnsOf(credentialingFixedSchema);
  const credentialHospitalIds = credTable.header.filter((h) => !fixed.includes(h));
  if (credentialHospitalIds.length === 0) warnings.push(`${files.credentials}: no hospital columns found`);
  const credentials = parseRows(
    credTable,
    credentialingSchema(credentialHospitalIds),
    warnings,
    (r, src) => {
      const row = r as Record<string, unknown>;
      return {
        ...src,
        physicianId: String(row.physician_id),
        name: String(row.name),
        credentialedHospitalIds: credentialHospitalIds.filter((h) => row[h] === true),
      };
    },
    [...fixed, ...credentialHospitalIds],
  );

  const baselineHourly = parseRows(table(files.baselineHourly), baselineHourlySchema, warnings, (r, src) => ({
    ...src,
    hospitalId: r.hospital_id,
    hospitalName: r.hospital_name,
    dowType: r.dow_type,
    hourStartEt: r.hour_start_et,
    meanConsults: r.mean_consults,
    p90Consults: r.p90_consults,
    weeksSampled: r.weeks_sampled,
  }));

  const coverageRequirements = parseRows(table(files.coverageRequirements), coverageRequirementsSchema, warnings, (r, src) => ({
    ...src,
    hospitalId: r.hospital_id,
    hospitalName: r.hospital_name,
    timeBlockEt: r.time_block_et,
    minAvailableCredentialedPhysicians: r.min_available_credentialed_physicians,
  }));

  const snapshot = parseSnapshot(files, table, warnings);

  const dataset: Dataset = {
    files,
    events,
    hospitals,
    physiciansOnShift,
    offShiftRoster,
    credentials,
    credentialHospitalIds,
    baselineHourly,
    coverageRequirements,
    snapshot,
    warnings,
  };
  warnings.push(...integrityWarnings(dataset));
  return dataset;
}

function parseSnapshot(files: DatasetFileNames, table: (name: string) => CsvTable, warnings: string[]): Snapshot | null {
  const { snapshotPhysicians: pFile, snapshotConsults: cFile } = files;
  if (pFile === null || cFile === null) {
    const absent = [pFile === null ? 'snapshot_physicians_*.csv' : '', cFile === null ? 'snapshot_open_consults_*.csv' : ''];
    warnings.push(`snapshot: ${absent.filter((a) => a !== '').join(' and ')} not found; no reference snapshot loaded`);
    return null;
  }
  const label = SNAPSHOT_PHYSICIANS_FILE.exec(pFile)?.[1] ?? '';
  const consultLabel = SNAPSHOT_CONSULTS_FILE.exec(cFile)?.[1] ?? '';
  if (label !== consultLabel) warnings.push(`snapshot: file labels differ (${pFile} vs ${cFile})`);

  const physicians = parseRows(table(pFile), snapshotPhysiciansSchema, warnings, (r, src) => ({
    ...src,
    physicianId: r.physician_id,
    name: r.name,
    shiftEt: r.shift_et,
    selfReportedStatus: r.self_reported_status,
    desktopAgent: r.desktop_agent,
    derivedState: r.derived_state,
    consultsThisShift: r.consults_this_shift,
    callsThisShift: r.calls_this_shift,
    openConsults: r.open_consults,
    minutesToShiftEnd: r.minutes_to_shift_end,
  }));
  const consults = parseRows(table(cFile), snapshotOpenConsultsSchema, warnings, (r, src) => ({
    ...src,
    consultId: r.consult_id,
    hospitalId: r.hospital_id,
    hospitalName: r.hospital_name,
    physicianId: r.physician_id === SNAPSHOT_UNASSIGNED ? null : r.physician_id,
    consultType: r.consult_type,
    currentStage: r.current_stage,
    stageEnteredAt: r.stage_entered_at,
    minutesInStage: r.minutes_in_stage,
    minutesSinceReceived: r.minutes_since_received,
  }));
  return { label, physicians, consults };
}

function findOne(names: readonly string[], pattern: RegExp): string | null {
  const hits = names.filter((n) => pattern.test(n)).sort();
  if (hits.length > 1) throw new DataParseError('dataset', null, `ambiguous snapshot files: ${hits.join(', ')}`);
  return hits[0] ?? null;
}

function parseRows<S extends z.AnyZodObject, T>(
  table: CsvTable,
  schema: S,
  warnings: string[],
  map: (row: z.output<S>, src: RowSource, raw: Readonly<Record<string, string>>) => T,
  expected: readonly string[] = columnsOf(schema),
): T[] {
  checkHeader(table, expected, warnings);
  return table.rows.map((row) => {
    const result = schema.safeParse(row.values);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => {
          const col = String(i.path[0] ?? '?');
          return `column "${col}" value "${row.values[col] ?? ''}": ${i.message}`;
        })
        .join('; ');
      throw new DataParseError(table.file, row.line, detail);
    }
    return map(result.data, { rowIndex: row.rowIndex, line: row.line }, row.values);
  });
}

/** CLAUDE.md rule 2: column names must match exactly. Missing columns are fatal; extras and reordering are reported. */
function checkHeader(table: CsvTable, expected: readonly string[], warnings: string[]): void {
  const missing = expected.filter((c) => !table.header.includes(c));
  if (missing.length > 0) {
    throw new DataParseError(
      table.file,
      1,
      `missing column(s) ${missing.map((c) => `"${c}"`).join(', ')}; expected header: ${expected.join(',')}; found: ${table.header.join(',')}`,
    );
  }
  const extra = table.header.filter((c) => !expected.includes(c));
  if (extra.length > 0) warnings.push(`${table.file}: extra column(s) ignored: ${extra.join(', ')}`);
  const order = table.header.filter((c) => expected.includes(c));
  if (order.join(',') !== expected.join(',')) warnings.push(`${table.file}: columns are in a different order than expected`);
}
