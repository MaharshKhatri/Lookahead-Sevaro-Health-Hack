import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, readCsvText } from '../src';
import { loadDataset } from '../src/data/loaders';
import { DATA_DIR, golden, rawDataLineCount, referenceTexts } from './helpers';

const dataset = loadDataset(DATA_DIR);
const texts = referenceTexts();

describe('reference data package loads', () => {
  it('finds every file named in brief "Synthetic Dataset", including both snapshot_*_1820.csv files', () => {
    expect(dataset.files).toEqual({
      events: 'event_stream.csv',
      hospitals: 'hospitals.csv',
      physiciansOnShift: 'physicians_on_shift.csv',
      offShiftRoster: 'physicians_off_shift_roster.csv',
      credentials: 'credentialing_matrix.csv',
      baselineHourly: 'baseline_hourly_volume.csv',
      coverageRequirements: 'coverage_requirements.csv',
      snapshotPhysicians: `snapshot_physicians_${golden.snapshotLabel}.csv`,
      snapshotConsults: `snapshot_open_consults_${golden.snapshotLabel}.csv`,
    });
    expect(dataset.snapshot?.label).toBe(golden.snapshotLabel);
  });

  it('row counts equal the recon counts and the raw line counts (no row dropped)', () => {
    const loaded: Record<string, number> = {
      [dataset.files.events]: dataset.events.length,
      [dataset.files.hospitals]: dataset.hospitals.length,
      [dataset.files.physiciansOnShift]: dataset.physiciansOnShift.length,
      [dataset.files.offShiftRoster]: dataset.offShiftRoster.length,
      [dataset.files.credentials]: dataset.credentials.length,
      [dataset.files.baselineHourly]: dataset.baselineHourly.length,
      [dataset.files.coverageRequirements]: dataset.coverageRequirements.length,
      [dataset.files.snapshotPhysicians ?? '']: dataset.snapshot?.physicians.length ?? -1,
      [dataset.files.snapshotConsults ?? '']: dataset.snapshot?.consults.length ?? -1,
    };
    expect(loaded).toEqual(golden.rowCounts);
    for (const [file, count] of Object.entries(golden.rowCounts)) {
      expect(rawDataLineCount(texts[file] ?? ''), file).toBe(count);
    }
  });

  it('parses every timestamp to a finite epoch ms (brief: "All timestamps include an explicit UTC offset")', () => {
    const instants = [
      ...dataset.events.flatMap((e) => [e.eventTime, e.ingestedAt]),
      ...dataset.offShiftRoster.flatMap((r) => [r.lastShiftEnd, r.nextShiftStart]),
    ];
    expect(instants.length).toBe(2 * dataset.events.length + 2 * dataset.offShiftRoster.length);
    expect(instants.filter((t) => !Number.isInteger(t))).toEqual([]);
  });

  it('every event_type is in the brief "Event types" list', () => {
    const table = readCsvText('event_stream.csv', texts['event_stream.csv'] ?? '');
    const known = new Set<string>(EVENT_TYPES);
    const unknown = table.rows
      .filter((r) => !known.has((r.values.event_type ?? '').trim()))
      .map((r) => `line ${r.line}: "${r.values.event_type}"`);
    expect(unknown, `unknown event types:\n${unknown.join('\n')}`).toEqual([]);
  });

  it('event type counts equal the recon counts', () => {
    const counts: Record<string, number> = {};
    for (const e of dataset.events) counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
    expect(counts).toEqual(golden.eventTypeCounts);
  });

  it('keeps duplicate rows and reports them as warnings (rows are never silently dropped)', () => {
    for (const id of golden.duplicateEventIds) {
      expect(dataset.events.filter((e) => e.eventId === id).length).toBe(2);
      expect(dataset.warnings.some((w) => w.includes(id))).toBe(true);
    }
  });

  it('maps snapshot physician_id "Unassigned" to null and keeps assigned IDs', () => {
    const consults = dataset.snapshot?.consults ?? [];
    const raw = readCsvText('c', texts[dataset.files.snapshotConsults ?? ''] ?? '').rows.map((r) => r.values.physician_id);
    expect(consults.map((c) => c.physicianId ?? 'Unassigned')).toEqual(raw);
    expect(consults.some((c) => c.physicianId === null)).toBe(true);
  });

  it('reads credentialing columns from the header (brief says headers lack the prefix; the file has full hospital IDs)', () => {
    expect(dataset.credentialHospitalIds).toEqual(dataset.hospitals.map((h) => h.hospitalId));
  });
});
