import type { Dataset } from '../types';

const SECONDS_PER_DAY = 86_400;

/**
 * Cross-file consistency checks. These only report; they never change or drop
 * rows (the replay decides what to do with, e.g., a duplicate event).
 */
export function integrityWarnings(d: Dataset): string[] {
  return [
    ...duplicateEventIds(d),
    ...ingestOrder(d),
    ...unknownEventRefs(d),
    ...duplicateKeys(d),
    ...credentialCoverage(d),
    ...nameMismatches(d),
    ...coverageTiling(d),
    ...baselineHours(d),
  ];
}

function duplicateEventIds(d: Dataset): string[] {
  const lines = new Map<string, number[]>();
  for (const e of d.events) lines.set(e.eventId, [...(lines.get(e.eventId) ?? []), e.line]);
  return [...lines]
    .filter(([, ls]) => ls.length > 1)
    .map(([id, ls]) => `${d.files.events}: event_id ${id} appears ${ls.length} times (lines ${ls.join(', ')})`);
}

/** Brief "Synthetic Dataset": event_stream.csv is "Sorted by ingested_at". */
function ingestOrder(d: Dataset): string[] {
  for (let i = 1; i < d.events.length; i++) {
    const prev = d.events[i - 1];
    const cur = d.events[i];
    if (prev !== undefined && cur !== undefined && cur.ingestedAt < prev.ingestedAt) {
      return [`${d.files.events}: not sorted by ingested_at (first at line ${cur.line})`];
    }
  }
  return [];
}

function unknownEventRefs(d: Dataset): string[] {
  const hospitals = new Set(d.hospitals.map((h) => h.hospitalId));
  const physicians = new Set([
    ...d.physiciansOnShift.map((p) => p.physicianId),
    ...d.offShiftRoster.map((p) => p.physicianId),
    ...d.credentials.map((p) => p.physicianId),
  ]);
  const badHospitals = new Set<string>();
  const badPhysicians = new Set<string>();
  for (const e of d.events) {
    if (e.hospitalId !== null && !hospitals.has(e.hospitalId)) badHospitals.add(e.hospitalId);
    if (e.physicianId !== null && !physicians.has(e.physicianId)) badPhysicians.add(e.physicianId);
  }
  const out: string[] = [];
  if (badHospitals.size > 0) out.push(`${d.files.events}: hospital_id not in ${d.files.hospitals}: ${[...badHospitals].join(', ')}`);
  if (badPhysicians.size > 0) out.push(`${d.files.events}: physician_id not in any physician file: ${[...badPhysicians].join(', ')}`);
  return out;
}

function duplicateKeys(d: Dataset): string[] {
  const check = (file: string, keys: readonly string[]): string[] => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const k of keys) (seen.has(k) ? dups : seen).add(k);
    return dups.size > 0 ? [`${file}: duplicate key(s) ${[...dups].join(', ')}`] : [];
  };
  return [
    ...check(d.files.hospitals, d.hospitals.map((h) => h.hospitalId)),
    ...check(d.files.physiciansOnShift, d.physiciansOnShift.map((p) => p.physicianId)),
    ...check(d.files.offShiftRoster, d.offShiftRoster.map((p) => p.physicianId)),
    ...check(d.files.credentials, d.credentials.map((p) => p.physicianId)),
    ...check(d.files.baselineHourly, d.baselineHourly.map((b) => `${b.hospitalId}/${b.dowType}/${b.hourStartEt.raw}`)),
    ...check(d.files.coverageRequirements, d.coverageRequirements.map((c) => `${c.hospitalId}/${c.timeBlockEt.raw}`)),
  ];
}

function credentialCoverage(d: Dataset): string[] {
  const out: string[] = [];
  const hospitals = new Set(d.hospitals.map((h) => h.hospitalId));
  const columns = new Set(d.credentialHospitalIds);
  const extraCols = d.credentialHospitalIds.filter((h) => !hospitals.has(h));
  const missingCols = d.hospitals.map((h) => h.hospitalId).filter((h) => !columns.has(h));
  if (extraCols.length > 0) out.push(`${d.files.credentials}: column(s) not in ${d.files.hospitals}: ${extraCols.join(', ')}`);
  if (missingCols.length > 0) out.push(`${d.files.credentials}: no column for hospital(s): ${missingCols.join(', ')}`);
  const credentialed = new Set(d.credentials.map((c) => c.physicianId));
  const uncredentialed = [...d.physiciansOnShift, ...d.offShiftRoster].map((p) => p.physicianId).filter((p) => !credentialed.has(p));
  if (uncredentialed.length > 0) out.push(`${d.files.credentials}: no row for physician(s): ${uncredentialed.join(', ')}`);
  return out;
}

function nameMismatches(d: Dataset): string[] {
  const out: string[] = [];
  const hospitalNames = new Map(d.hospitals.map((h) => [h.hospitalId, h.hospitalName]));
  const hospitalRows = [
    ...d.baselineHourly.map((r) => ({ file: d.files.baselineHourly, id: r.hospitalId, name: r.hospitalName })),
    ...d.coverageRequirements.map((r) => ({ file: d.files.coverageRequirements, id: r.hospitalId, name: r.hospitalName })),
    ...(d.snapshot?.consults ?? []).map((r) => ({ file: d.files.snapshotConsults ?? 'snapshot', id: r.hospitalId, name: r.hospitalName })),
  ];
  const physicianNames = new Map(d.credentials.map((c) => [c.physicianId, c.name]));
  const physicianRows = [
    ...d.physiciansOnShift.map((r) => ({ file: d.files.physiciansOnShift, id: r.physicianId, name: r.name })),
    ...d.offShiftRoster.map((r) => ({ file: d.files.offShiftRoster, id: r.physicianId, name: r.name })),
    ...(d.snapshot?.physicians ?? []).map((r) => ({ file: d.files.snapshotPhysicians ?? 'snapshot', id: r.physicianId, name: r.name })),
  ];
  const report = (rows: { file: string; id: string; name: string }[], ref: Map<string, string>, refFile: string) => {
    const seen = new Set<string>();
    for (const r of rows) {
      const expected = ref.get(r.id);
      const key = `${r.file}/${r.id}`;
      if (expected !== undefined && expected !== r.name && !seen.has(key)) {
        seen.add(key);
        out.push(`${r.file}: name for ${r.id} is "${r.name}" but ${refFile} says "${expected}"`);
      }
    }
  };
  report(hospitalRows, hospitalNames, d.files.hospitals);
  report(physicianRows, physicianNames, d.files.credentials);
  return out;
}

/** Each hospital's coverage blocks should tile the 24-hour day exactly once. */
function coverageTiling(d: Dataset): string[] {
  const byHospital = new Map<string, number[]>();
  for (const c of d.coverageRequirements) {
    const b = c.timeBlockEt;
    const seconds = b.wrapsMidnight
      ? SECONDS_PER_DAY - b.start.secondOfDay + b.end.secondOfDay
      : b.end.secondOfDay - b.start.secondOfDay;
    byHospital.set(c.hospitalId, [...(byHospital.get(c.hospitalId) ?? []), seconds]);
  }
  return [...byHospital]
    .filter(([, spans]) => spans.reduce((a, s) => a + s, 0) !== SECONDS_PER_DAY)
    .map(([h]) => `${d.files.coverageRequirements}: blocks for ${h} do not add up to 24 hours`);
}

function baselineHours(d: Dataset): string[] {
  const hours = new Map<string, Set<number>>();
  for (const b of d.baselineHourly) {
    const key = `${b.hospitalId}/${b.dowType}`;
    hours.set(key, (hours.get(key) ?? new Set()).add(b.hourStartEt.secondOfDay));
  }
  return [...hours]
    .filter(([, hs]) => hs.size !== 24)
    .map(([key, hs]) => `${d.files.baselineHourly}: ${key} has ${hs.size} hourly rows, expected 24`);
}
