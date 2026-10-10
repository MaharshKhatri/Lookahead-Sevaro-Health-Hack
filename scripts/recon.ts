/**
 * Data reconnaissance: `pnpm recon [dataDir] [outFile]` -> docs/DATA_PROFILE.md.
 *
 * Profiles every CSV, analyses the event stream (ordering, lateness,
 * duplicates), and checks candidate derivations of every snapshot column
 * against the event stream. The derivation checks here are recon only and
 * deliberately naive; they are not the replay engine.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DateTime } from 'luxon';
import {
  CONSULT_TYPE_DESCRIPTION_SUFFIX,
  DATASET_FILES,
  ET_ZONE,
  EVENT_TYPES,
  LATE_EVENT_FLAG_LAG_MS,
  STATUS_DESCRIPTION_PREFIX,
  etDateOf,
  etWallClockToEpoch,
  type CsvTable,
  type Dataset,
  type EventType,
  type RawEvent,
  type SnapshotConsultRow,
  type SnapshotPhysicianRow,
} from '@lookahead/engine';
import { loadDataset, readCsvFile } from '@lookahead/engine/loaders';

const dataDir = process.argv[2] ?? 'data/raw';
const outPath = process.argv[3] ?? 'docs/DATA_PROFILE.md';
const LIST_LIMIT = 25;

// ---------- markdown helpers ----------
const out: string[] = [];
const heading = (level: number, text: string) => out.push(`${'#'.repeat(level)} ${text}`, '');
const para = (text: string) => out.push(text, '');
const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const code = (v: string) => (v === '' ? '(empty)' : `\`${v}\``);
function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): void {
  out.push(`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`);
  for (const r of rows) out.push(`| ${r.map(cell).join(' | ')} |`);
  out.push('');
}
const et = (ms: number, fmt = 'HH:mm:ss') => DateTime.fromMillis(ms, { zone: ET_ZONE }).toFormat(fmt);
const yes = (b: boolean) => (b ? 'yes' : 'NO');

// ---------- generic column profiling ----------
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PATTERNS: readonly (readonly [string, (v: string) => boolean])[] = [
  ['integer', (v) => /^-?\d+$/.test(v)],
  ['decimal', (v) => /^-?\d+(?:\.\d+)?$/.test(v)],
  ['datetime with UTC offset', (v) => ISO_OFFSET.test(v)],
  ['clock time HH:MM:SS', (v) => /^\d{2}:\d{2}:\d{2}$/.test(v)],
  ['clock time HH:MM', (v) => /^\d{2}:\d{2}$/.test(v)],
  ['clock range HH:MM-HH:MM', (v) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(v)],
  ['id PREFIX-NNN', (v) => /^[A-Z]+-\d+$/.test(v)],
  ['flag Y/blank', (v) => v === 'Y'],
  ['Yes/No', (v) => v === 'Yes' || v === 'No'],
  ['IANA zone', (v) => /^[A-Z][A-Za-z_]+\/[A-Za-z_/]+$/.test(v)],
];

interface ColumnProfile {
  readonly name: string;
  readonly type: string;
  readonly empty: number;
  readonly distinct: number;
  readonly listed: readonly string[] | null;
}

function inferType(values: readonly string[]): string {
  const nonEmpty = values.filter((v) => v !== '');
  if (nonEmpty.length === 0) return 'always empty';
  const distinct = new Set(nonEmpty);
  for (const [name, test] of PATTERNS) if (nonEmpty.every(test)) return name;
  let best: { name: string; hits: number } | null = null;
  for (const [name, test] of PATTERNS) {
    const hits = nonEmpty.filter(test).length;
    if (hits > (best?.hits ?? 0)) best = { name, hits };
  }
  if (best !== null && best.hits >= nonEmpty.length / 2) {
    const test = PATTERNS.find(([n]) => n === best.name)?.[1] ?? (() => true);
    const others = [...new Set(nonEmpty.filter((v) => !test(v)))].slice(0, 5);
    return `${best.name}, plus other value(s): ${others.map((o) => `"${o}"`).join(', ')}`;
  }
  return distinct.size <= LIST_LIMIT ? 'enum (text)' : 'text';
}

function profileColumns(t: CsvTable): ColumnProfile[] {
  return t.header.map((name) => {
    const values = t.rows.map((r) => (r.values[name] ?? '').trim());
    const type = inferType(values);
    const distinctValues = [...new Set(values)].sort(naturalCompare);
    const isIdOrEnum =
      name.endsWith('_id') || /^(id|enum|flag|Yes\/No|IANA)/.test(type) || type.includes('other value') || /^[A-Z]+-\d+$/.test(name);
    return {
      name,
      type,
      empty: values.filter((v) => v === '').length,
      distinct: distinctValues.length,
      listed: isIdOrEnum && distinctValues.length <= LIST_LIMIT ? distinctValues : null,
    };
  });
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

// ---------- event helpers ----------
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;
const offsetOf = (raw: string) => OFFSET.exec(raw)?.[1] ?? '(none)';
const payloadKey = (e: RawEvent) =>
  [e.eventTimeRaw, e.consultId, e.eventType, e.physicianId, e.hospitalId, e.description].join('|');
const fullRow = (e: RawEvent) =>
  [e.line, e.eventId, e.eventTimeRaw, e.ingestedAtRaw, e.consultId ?? '', e.eventType, e.physicianId ?? '', e.hospitalId ?? '', e.description];
const FULL_ROW_HEADERS = ['line', 'event_id', 'event_time', 'ingested_at', 'consult_id', 'event_type', 'physician_id', 'hospital_id', 'description'];
const byEventTime = (a: RawEvent, b: RawEvent) => a.eventTime - b.eventTime || a.ingestedAt - b.ingestedAt || a.rowIndex - b.rowIndex;

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list === undefined) m.set(k, [it]);
    else list.push(it);
  }
  return m;
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? Number.NaN;
}

/** Rows whose event_time is earlier than the max event_time of all rows ingested strictly before them. */
function lateEvents(events: readonly RawEvent[]): { e: RawEvent; behindMs: number }[] {
  const byIngest = [...events].sort((a, b) => a.ingestedAt - b.ingestedAt || a.rowIndex - b.rowIndex);
  const late: { e: RawEvent; behindMs: number }[] = [];
  let watermark = Number.NEGATIVE_INFINITY;
  let i = 0;
  while (i < byIngest.length) {
    const groupStart = byIngest[i]?.ingestedAt;
    const group: RawEvent[] = [];
    while (i < byIngest.length && byIngest[i]?.ingestedAt === groupStart) group.push(byIngest[i++] as RawEvent);
    for (const e of group) if (e.eventTime < watermark) late.push({ e, behindMs: watermark - e.eventTime });
    for (const e of group) watermark = Math.max(watermark, e.eventTime);
  }
  return late.sort((a, b) => a.e.rowIndex - b.e.rowIndex);
}

/** OQ-04 default: drop a row whose event_id and payload equal an earlier-ingested row. */
function dedupe(events: readonly RawEvent[]): { kept: RawEvent[]; dropped: RawEvent[] } {
  const seen = new Set<string>();
  const kept: RawEvent[] = [];
  const dropped: RawEvent[] = [];
  for (const e of [...events].sort((a, b) => a.ingestedAt - b.ingestedAt || a.rowIndex - b.rowIndex)) {
    const k = `${e.eventId}|${payloadKey(e)}`;
    if (seen.has(k)) dropped.push(e);
    else {
      seen.add(k);
      kept.push(e);
    }
  }
  return { kept, dropped };
}

// ---------- main ----------
function main(): void {
  const csvNames = readdirSync(dataDir)
    .filter((n) => n.toLowerCase().endsWith('.csv'))
    .sort(naturalCompare);
  let dataset: Dataset;
  try {
    dataset = loadDataset(dataDir);
  } catch (err) {
    console.error(`recon: typed load failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  para('<!-- Generated by `pnpm recon` (scripts/recon.ts). Do not edit by hand; re-run instead. -->');
  heading(1, 'Data profile');
  para(
    `Source directory: \`${dataDir}\`. All times shown as ET wall-clock (${ET_ZONE}) unless a raw value is quoted. ` +
      'Typed loading via `loadDataset` succeeded for every file.',
  );
  heading(2, 'Files');
  const tables = new Map<string, CsvTable>();
  const fileRows: unknown[][] = [];
  for (const name of csvNames) {
    const path = join(dataDir, name);
    const raw = readFileSync(path);
    const t = readCsvFile(path, name);
    tables.set(name, t);
    const text = raw.toString('utf8');
    fileRows.push([
      `\`${name}\``,
      t.rows.length,
      t.header.length,
      text.includes('\r\n') ? 'CRLF' : 'LF',
      raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 'yes' : 'no',
      text.includes('"') ? 'yes' : 'no',
      t.blankLines,
    ]);
  }
  table(['file', 'data rows', 'columns', 'line endings', 'BOM', 'quote chars', 'blank lines'], fileRows);
  para(`Loader warnings (${dataset.warnings.length}):`);
  out.push(...(dataset.warnings.length > 0 ? dataset.warnings.map((w) => `- ${w}`) : ['- none']), '');

  for (const name of csvNames) {
    const t = tables.get(name);
    if (t !== undefined) profileFile(t);
  }

  eventStreamSection(dataset);
  snapshotSection(dataset);
  coverageAndBaselineSection(dataset);
  rosterSection(dataset);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${out.join('\n').trimEnd()}\n`);
  console.log(`recon: wrote ${outPath}`);
  for (const r of fileRows) console.log(`  ${String(r[0]).replace(/`/g, '').padEnd(36)} ${String(r[1]).padStart(5)} rows`);
  console.log(`  warnings: ${dataset.warnings.length}`);
}

function profileFile(t: CsvTable): void {
  heading(2, `\`${t.file}\``);
  para(`Rows: **${t.rows.length}**. Columns (${t.header.length}, in order): ${t.header.map((h) => `\`${h}\``).join(', ')}`);
  const cols = profileColumns(t);
  table(
    ['#', 'column', 'inferred type', 'empty', 'distinct', 'values (ID/enum columns, if <= 25)'],
    cols.map((c, i) => [i + 1, `\`${c.name}\``, c.type, c.empty, c.distinct, c.listed === null ? '' : c.listed.map(code).join(', ')]),
  );
  para('Sample rows (first 3):');
  table(
    t.header,
    t.rows.slice(0, 3).map((r) => t.header.map((h) => r.values[h] ?? '')),
  );
}

function eventStreamSection(d: Dataset): void {
  const ev = d.events;
  heading(2, 'Event stream analysis');

  heading(3, 'Event type counts');
  const counts = groupBy(ev, (e) => e.eventType);
  const known = new Set<string>(EVENT_TYPES);
  table(
    ['event_type', 'rows', 'in brief "Event types"'],
    [...counts].sort((a, b) => b[1].length - a[1].length || naturalCompare(a[0], b[0])).map(([t, l]) => [`\`${t}\``, l.length, yes(known.has(t))]),
  );
  const unseen = EVENT_TYPES.filter((t) => !counts.has(t));
  para(`Brief event types never seen: ${unseen.length === 0 ? 'none' : unseen.map((t) => `\`${t}\``).join(', ')}. Total rows: ${ev.length}.`);

  heading(3, 'Time range, offsets, ordering');
  const minBy = (f: (e: RawEvent) => number) => ev.reduce((a, b) => (f(b) < f(a) ? b : a));
  const maxBy = (f: (e: RawEvent) => number) => ev.reduce((a, b) => (f(b) > f(a) ? b : a));
  const offsets = (f: (e: RawEvent) => string) => [...new Set(ev.map((e) => offsetOf(f(e))))].sort().map(code).join(', ');
  const ingestSorted = ev.every((e, i) => i === 0 || (ev[i - 1]?.ingestedAt ?? 0) <= e.ingestedAt);
  const idSorted = ev.every((e, i) => i === 0 || naturalCompare(ev[i - 1]?.eventId ?? '', e.eventId) <= 0);
  const eventTimeSorted = ev.every((e, i) => i === 0 || (ev[i - 1]?.eventTime ?? 0) <= e.eventTime);
  const rosterOffsets = [...new Set(d.offShiftRoster.flatMap((r) => [offsetOf(r.lastShiftEndRaw), offsetOf(r.nextShiftStartRaw)]))];
  table(
    ['fact', 'value'],
    [
      ['min event_time', `\`${minBy((e) => e.eventTime).eventTimeRaw}\``],
      ['max event_time', `\`${maxBy((e) => e.eventTime).eventTimeRaw}\``],
      ['min ingested_at', `\`${minBy((e) => e.ingestedAt).ingestedAtRaw}\``],
      ['max ingested_at', `\`${maxBy((e) => e.ingestedAt).ingestedAtRaw}\``],
      ['UTC offsets in event_time', offsets((e) => e.eventTimeRaw)],
      ['UTC offsets in ingested_at', offsets((e) => e.ingestedAtRaw)],
      ['UTC offsets in off-shift roster timestamps', rosterOffsets.sort().map(code).join(', ')],
      ['file sorted by ingested_at (non-decreasing)', yes(ingestSorted)],
      ['file order = event_id order (non-decreasing)', yes(idSorted)],
      ['file sorted by event_time', yes(eventTimeSorted)],
    ],
  );

  heading(3, 'Ingestion lag (ingested_at - event_time)');
  const lags = ev.map((e) => (e.ingestedAt - e.eventTime) / 1000).sort((a, b) => a - b);
  table(
    ['min', 'median (p50)', 'p95', 'max', 'negative lags'],
    [[`${lags[0]} s`, `${percentile(lags, 50)} s`, `${percentile(lags, 95)} s`, `${lags.at(-1)} s`, lags.filter((l) => l < 0).length]],
  );
  para('Percentiles use the nearest-rank method. Histogram (lag seconds: rows):');
  const hist = groupBy(lags, (l) => String(l));
  para([...hist].sort((a, b) => Number(a[0]) - Number(b[0])).map(([l, xs]) => `${l} s: ${xs.length}`).join(' · '));

  heading(3, 'Late events');
  const late = lateEvents(ev);
  const bigLag = late.filter(({ e }) => e.ingestedAt - e.eventTime > LATE_EVENT_FLAG_LAG_MS);
  para(
    `Definition: a row is late when its event_time is earlier than the max event_time of all rows ingested strictly before it. ` +
      `**${late.length}** rows qualify. ${bigLag.length} of them have lag above ${LATE_EVENT_FLAG_LAG_MS / 1000} s ` +
      `(policy LATE_EVENT_FLAG_LAG_MS, OQ-12); the rest are ingestion jitter of a few seconds.`,
  );
  table(
    ['line', 'event_id', 'event_type', 'consult_id', 'physician_id', 'event_time', 'ingested_at', 'lag (s)', 'behind watermark (s)'],
    late.map(({ e, behindMs }) => [
      e.line,
      e.eventId,
      `\`${e.eventType}\``,
      e.consultId ?? '',
      e.physicianId ?? '',
      et(e.eventTime),
      et(e.ingestedAt),
      (e.ingestedAt - e.eventTime) / 1000,
      behindMs / 1000,
    ]),
  );

  const fileOrderLate = ev.filter((e, i) => ev.slice(0, i).some((p) => p.eventTime > e.eventTime));
  const strictIds = new Set(late.map(({ e }) => e.eventId));
  const extra = fileOrderLate.filter((e) => !strictIds.has(e.eventId));
  para(
    `Variant: comparing against every row earlier in the file (so rows with an equal ingested_at count as "before") flags ` +
      `**${fileOrderLate.length}** rows. The ${extra.length} extra rows, all with lag <= ${Math.max(0, ...extra.map((e) => (e.ingestedAt - e.eventTime) / 1000))} s: ` +
      `${extra.map((e) => `${e.eventId} (\`${e.eventType}\`, line ${e.line})`).join(', ') || 'none'}.`,
  );

  heading(3, 'Description values per event type');
  para('Some values exist only in description text (OQ-14): self-reported status, consult type, phone-only, imaging modality.');
  const descs = groupBy(ev, (e) => `${e.eventType}\u0000${e.description}`);
  table(
    ['event_type', 'description', 'rows'],
    [...descs]
      .map(([k, l]) => [...k.split('\u0000'), l.length] as const)
      .sort((a, b) => naturalCompare(String(a[0]), String(b[0])) || Number(b[2]) - Number(a[2]))
      .map(([t, desc, n]) => [`\`${t}\``, desc, n]),
  );

  heading(3, 'Duplicates');
  const dupGroups = (key: (e: RawEvent) => string) => [...groupBy(ev, key).values()].filter((g) => g.length > 1);
  const sections: [string, RawEvent[][]][] = [
    ['(a) duplicate event_id', dupGroups((e) => e.eventId)],
    ['(b) identical in every column except event_id / ingested_at', dupGroups(payloadKey)],
    [
      '(c) same (event_type, consult_id, physician_id, hospital_id, event_time)',
      dupGroups((e) => [e.eventType, e.consultId, e.physicianId, e.hospitalId, e.eventTime].join('|')),
    ],
  ];
  for (const [title, groups] of sections) {
    para(`**${title}**: ${groups.length} group(s).`);
    if (groups.length > 0) table(FULL_ROW_HEADERS, groups.flat().map(fullRow));
  }

  heading(3, 'Per-consult event sequences (ordered by event_time)');
  const byConsult = groupBy(
    ev.filter((e) => e.consultId !== null),
    (e) => e.consultId ?? '',
  );
  const firstTime = (id: string) => Math.min(...(byConsult.get(id) ?? []).map((e) => e.eventTime));
  const firstFive = [...byConsult.keys()].sort((a, b) => firstTime(a) - firstTime(b) || naturalCompare(a, b)).slice(0, 5);
  const snapIds = (d.snapshot?.consults ?? []).map((c) => c.consultId);
  const { dropped } = dedupe(ev);
  const droppedRows = new Set(dropped.map((e) => e.rowIndex));
  const lateRows = new Set(late.map(({ e }) => e.rowIndex));
  const sequence = (id: string) =>
    [...(byConsult.get(id) ?? [])]
      .sort(byEventTime)
      .map((e) => {
        const tags = [
          e.physicianId ?? '',
          droppedRows.has(e.rowIndex) ? 'DUPLICATE' : '',
          lateRows.has(e.rowIndex) ? `late, lag ${(e.ingestedAt - e.eventTime) / 1000}s` : '',
        ].filter((t) => t !== '');
        return `\`${e.eventType}\` ${et(e.eventTime)}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
      })
      .join(' → ');
  const hospitalOf = (id: string) => byConsult.get(id)?.find((e) => e.hospitalId !== null)?.hospitalId ?? '?';
  para(`First 5 consults by first event_time (${byConsult.size} consults in total):`);
  out.push(...firstFive.map((id) => `- **${id}** (${hospitalOf(id)}): ${sequence(id)}`), '');
  para(`Every consult in the snapshot (${snapIds.length}):`);
  out.push(...snapIds.map((id) => `- **${id}** (${hospitalOf(id)}): ${sequence(id)}`), '');
}

// ---------- snapshot derivation checks ----------
const STAGE_ON: Partial<Record<EventType, string>> = {
  consult_received: 'Received',
  consult_triaged: 'Triaged',
  physician_assigned: 'Assigned',
  incoming_call_started: 'Provider Contacted',
  imaging_requested: 'CT/CTA or Imaging Pending',
  imaging_returned: 'Imaging Review',
  video_started: 'Video Consult In Progress',
  video_ended: 'Note Pending',
  note_started: 'Documentation',
  note_signed: 'Signed Off',
};

interface PhysicianSignals {
  status: string | null;
  agentOffline: boolean;
  camera: boolean;
  calls: Set<string>;
  videos: Set<string>;
  notes: Set<string>;
  ringing: string | null;
}

function snapshotSection(d: Dataset): void {
  heading(2, 'Snapshot columns and candidate derivations');
  const snap = d.snapshot;
  if (snap === null) {
    para('No snapshot files found; nothing to check.');
    return;
  }
  const lastEvent = d.events.reduce((a, b) => (b.eventTime > a.eventTime ? b : a));
  const date = etDateOf(lastEvent.eventTime);
  const m = /^(\d{2})(\d{2})$/.exec(snap.label);
  if (m === null) {
    para(`Snapshot label "${snap.label}" is not HHMM; derivation checks skipped.`);
    return;
  }
  const now = etWallClockToEpoch(date, Number(m[1]) * 3600 + Number(m[2]) * 60);
  para(
    `\`now\` = snapshot label ${snap.label} read as ET wall-clock on the ET date of the latest event (${date}) = ` +
      `\`${DateTime.fromMillis(now, { zone: ET_ZONE }).toISO()}\` (epoch ms ${now}). Brief: "The reference point for 'now' is 18:20:00 ET." ` +
      'Checks below use events with event_time <= now, de-duplicated with the OQ-04 default key (event_id + payload), ordered by event_time.',
  );

  const ordered = dedupe(d.events).kept.filter((e) => e.eventTime <= now).sort(byEventTime);
  const consultEvents = groupBy(
    ordered.filter((e) => e.consultId !== null),
    (e) => e.consultId ?? '',
  );
  const hospitalNames = new Map(d.hospitals.map((h) => [h.hospitalId, h.hospitalName]));
  const clockToEpoch = (secondOfDay: number) => etWallClockToEpoch(date, secondOfDay);
  const minutes = (ms: number) => Math.floor(ms / 60_000);

  // consult replay (naive, recon only)
  interface ConsultView {
    hospitalId: string | null;
    received: number | null;
    type: string | null;
    physician: string | null;
    stage: string | null;
    enteredAt: number | null;
    enteredBy: string | null;
  }
  const view = (id: string): ConsultView => {
    const v: ConsultView = { hospitalId: null, received: null, type: null, physician: null, stage: null, enteredAt: null, enteredBy: null };
    for (const e of consultEvents.get(id) ?? []) {
      if (e.eventType === 'consult_received') {
        v.hospitalId = e.hospitalId;
        v.received = e.eventTime;
        v.type = e.description.endsWith(CONSULT_TYPE_DESCRIPTION_SUFFIX) ? e.description.slice(0, -CONSULT_TYPE_DESCRIPTION_SUFFIX.length) : null;
      }
      if (e.eventType === 'physician_assigned') v.physician = e.physicianId;
      const next = STAGE_ON[e.eventType];
      if (next !== undefined && (e.eventType !== 'incoming_call_started' || v.stage === 'Assigned')) {
        v.stage = next;
        v.enteredAt = e.eventTime;
        v.enteredBy = e.eventType;
      }
    }
    return v;
  };
  const openIds = [...consultEvents.keys()].filter((id) => !(consultEvents.get(id) ?? []).some((e) => e.eventType === 'note_signed'));
  const snapIds = snap.consults.map((c) => c.consultId);
  const missingFromSnap = openIds.filter((id) => !snapIds.includes(id));
  const extraInSnap = snapIds.filter((id) => !openIds.includes(id));

  heading(3, `\`${d.files.snapshotConsults}\``);
  type Check = [column: string, derivation: string, ok: number, mismatches: string[]];
  const checks: Check[] = [];
  const check = (column: string, derivation: string, compare: (c: SnapshotConsultRow, v: ConsultView) => [unknown, unknown]) => {
    const mism: string[] = [];
    let ok = 0;
    for (const c of snap.consults) {
      const [actual, expected] = compare(c, view(c.consultId));
      if (String(actual) === String(expected)) ok++;
      else mism.push(`${c.consultId}: file ${String(actual)} vs derived ${String(expected)}`);
    }
    checks.push([column, derivation, ok, mism]);
  };
  checks.push([
    'consult_id',
    'Consults with at least one event and no `note_signed` (open = not Signed Off).',
    missingFromSnap.length === 0 && extraInSnap.length === 0 ? snap.consults.length : 0,
    [...missingFromSnap.map((id) => `${id}: open in events, missing from snapshot`), ...extraInSnap.map((id) => `${id}: in snapshot, not open in events`)],
  ]);
  check('hospital_id', '`hospital_id` of the consult_received event.', (c, v) => [c.hospitalId, v.hospitalId]);
  check('hospital_name', 'Join hospital_id to hospitals.csv.', (c, v) => [c.hospitalName, hospitalNames.get(v.hospitalId ?? '')]);
  check('physician_id', '`physician_id` of the latest physician_assigned; "Unassigned" if none (incoming_call_ringing does not assign).', (c, v) => [
    c.physicianId ?? 'Unassigned',
    v.physician ?? 'Unassigned',
  ]);
  check('consult_type', `consult_received description "<type>${CONSULT_TYPE_DESCRIPTION_SUFFIX}" (only source of the type; OQ-14).`, (c, v) => [
    c.consultType,
    v.type,
  ]);
  check(
    'current_stage',
    'Stage of the latest stage-changing event: consult_received→Received, consult_triaged→Triaged, physician_assigned→Assigned, ' +
      'incoming_call_started (while Assigned)→Provider Contacted, imaging_requested→CT/CTA or Imaging Pending, imaging_returned→Imaging Review, ' +
      'video_started→Video Consult In Progress, video_ended→Note Pending, note_started→Documentation, note_signed→Signed Off. ' +
      'Outgoing calls, call ends, ringing and routing failures do not change stage (OQ-18).',
    (c, v) => [c.currentStage, v.stage],
  );
  check('stage_entered_at', 'ET clock time (HH:MM:SS) of that stage-changing event.', (c, v) => [c.stageEnteredAt.raw, v.enteredAt === null ? null : et(v.enteredAt)]);
  check('minutes_in_stage', 'floor((now - stage_entered_at) / 60 000), using the file\'s own stage_entered_at as ET on the scenario date.', (c) => [
    c.minutesInStage,
    minutes(now - clockToEpoch(c.stageEnteredAt.secondOfDay)),
  ]);
  check('minutes_since_received', 'floor((now - consult_received.event_time) / 60 000).', (c, v) => [
    c.minutesSinceReceived,
    v.received === null ? null : minutes(now - v.received),
  ]);
  const enteredBy = groupBy(snap.consults, (c) => `${c.currentStage} ← ${view(c.consultId).enteredBy ?? '?'}`);
  checkTable(checks, snap.consults.length);
  para(`Stage → entering event type observed in the snapshot: ${[...enteredBy].map(([k, v]) => `${k} (${v.length})`).join('; ')}.`);

  // physicians
  heading(3, `\`${d.files.snapshotPhysicians}\``);
  const signals = new Map<string, PhysicianSignals>();
  const sig = (p: string): PhysicianSignals => {
    let s = signals.get(p);
    if (s === undefined) {
      s = { status: null, agentOffline: false, camera: false, calls: new Set(), videos: new Set(), notes: new Set(), ringing: null };
      signals.set(p, s);
    }
    return s;
  };
  for (const e of ordered) {
    if (e.physicianId === null) continue;
    const s = sig(e.physicianId);
    const c = e.consultId ?? '';
    switch (e.eventType) {
      case 'physician_status_changed':
        s.status = e.description.startsWith(STATUS_DESCRIPTION_PREFIX) ? e.description.slice(STATUS_DESCRIPTION_PREFIX.length) : `?${e.description}`;
        break;
      case 'agent_heartbeat_lost':
        s.agentOffline = true;
        break;
      case 'camera_active':
      case 'camera_inactive':
        s.camera = e.eventType === 'camera_active';
        s.agentOffline = false;
        break;
      case 'incoming_call_ringing':
        s.ringing = c;
        break;
      case 'incoming_call_started':
        s.calls.add(`incoming ${c}`);
        s.ringing = null;
        break;
      case 'incoming_call_ended':
        s.calls.delete(`incoming ${c}`);
        break;
      case 'outgoing_call_started':
        s.calls.add(`outgoing ${c}`);
        break;
      case 'outgoing_call_ended':
        s.calls.delete(`outgoing ${c}`);
        break;
      case 'video_started':
        s.videos.add(c);
        break;
      case 'video_ended':
        s.videos.delete(c);
        break;
      case 'note_started':
        s.notes.add(c);
        break;
      case 'note_signed':
        s.notes.delete(c);
        break;
      default:
        break;
    }
  }
  const candidateState = (s: PhysicianSignals): string => {
    const calls = [...s.calls];
    if (calls.some((x) => x.startsWith('incoming'))) return 'Incoming Hospital Call';
    if (calls.some((x) => x.startsWith('outgoing'))) return 'Outgoing Hospital Call';
    if (s.videos.size > 0) return 'Video Consult In Progress';
    if (s.camera && !s.agentOffline && s.status !== 'In Meeting') return 'Camera Active - No Synapse Session';
    if (s.status === 'Temporarily Unavailable') return 'Temporarily Unavailable';
    if (s.notes.size > 0) return 'Documentation / Note';
    if (s.status === 'In Meeting') return 'In Meeting';
    return 'Available';
  };
  const count = (p: string, types: readonly EventType[]) => ordered.filter((e) => e.physicianId === p && types.includes(e.eventType)).length;
  const onShift = new Map(d.physiciansOnShift.map((p) => [p.physicianId, p]));
  const openByPhysician = (p: string) => openIds.filter((id) => view(id).physician === p).length;
  const pChecks: Check[] = [];
  const pCheck = (column: string, derivation: string, compare: (r: SnapshotPhysicianRow) => [unknown, unknown]) => {
    const mism: string[] = [];
    let ok = 0;
    for (const r of snap.physicians) {
      const [actual, expected] = compare(r);
      if (String(actual) === String(expected)) ok++;
      else mism.push(`${r.physicianId}: file ${String(actual)} vs derived ${String(expected)}`);
    }
    pChecks.push([column, derivation, ok, mism]);
  };
  pCheck('physician_id', 'Same set as physicians_on_shift.csv.', (r) => [r.physicianId, onShift.has(r.physicianId) ? r.physicianId : '(not on shift)']);
  pCheck('name', 'Join to physicians_on_shift.csv.', (r) => [r.name, onShift.get(r.physicianId)?.name]);
  pCheck('shift_et', 'physicians_on_shift shift_start_et + "-" + shift_end_et.', (r) => {
    const p = onShift.get(r.physicianId);
    return [r.shiftEt.raw, p === undefined ? null : `${p.shiftStartEt.raw}-${p.shiftEndEt.raw}`];
  });
  pCheck('self_reported_status', `Latest physician_status_changed, description after "${STATUS_DESCRIPTION_PREFIX}" (OQ-14).`, (r) => [
    r.selfReportedStatus,
    signals.get(r.physicianId)?.status,
  ]);
  pCheck('desktop_agent', '"Offline" after agent_heartbeat_lost until the next camera_* event from that physician, else "Online" (OQ-16).', (r) => [
    r.desktopAgent,
    signals.get(r.physicianId)?.agentOffline === true ? 'Offline' : 'Online',
  ]);
  pCheck(
    'derived_state',
    'First match: open incoming call → open outgoing call → open video → camera active (agent online, status not In Meeting) → ' +
      'status Temporarily Unavailable → open note (note_started, no note_signed) → status In Meeting → Available (OQ-15).',
    (r) => [r.derivedState, candidateState(sig(r.physicianId))],
  );
  pCheck('consults_this_shift', 'Count of physician_assigned events for the physician (OQ-11).', (r) => [
    r.consultsThisShift,
    count(r.physicianId, ['physician_assigned']),
  ]);
  pCheck('calls_this_shift', 'Count of incoming_call_started + outgoing_call_started; ringing excluded (OQ-11).', (r) => [
    r.callsThisShift,
    count(r.physicianId, ['incoming_call_started', 'outgoing_call_started']),
  ]);
  pCheck('open_consults', 'Open consults whose latest physician_assigned is this physician (= rows in the consult snapshot).', (r) => [
    r.openConsults,
    openByPhysician(r.physicianId),
  ]);
  pCheck('minutes_to_shift_end', '(shift_end_et on the scenario date - now) / 60 000; an end before the start means the next day.', (r) => {
    const p = onShift.get(r.physicianId);
    if (p === undefined) return [r.minutesToShiftEnd, null];
    const endSec = p.shiftEndEt.secondOfDay + (p.shiftEndEt.secondOfDay <= p.shiftStartEt.secondOfDay ? 86_400 : 0);
    return [r.minutesToShiftEnd, (clockToEpoch(endSec) - now) / 60_000];
  });
  checkTable(pChecks, snap.physicians.length);
  para('Signals open at `now` per physician (what the derived_state check saw):');
  table(
    ['physician', 'status', 'agent', 'open calls', 'open video', 'camera', 'open notes', 'phone ringing', 'candidate', 'snapshot'],
    snap.physicians.map((r) => {
      const s = sig(r.physicianId);
      return [
        r.physicianId,
        s.status ?? '',
        s.agentOffline ? 'offline' : 'online',
        [...s.calls].join(', '),
        [...s.videos].join(', '),
        s.agentOffline ? 'unknown' : s.camera ? 'active' : 'inactive',
        [...s.notes].join(', '),
        s.ringing ?? '',
        candidateState(s),
        r.derivedState,
      ];
    }),
  );
  const alt = (p: string) => count(p, ['incoming_call_started', 'outgoing_call_started', 'incoming_call_ringing']);
  const altDiff = snap.physicians.filter((r) => alt(r.physicianId) !== r.callsThisShift).map((r) => `${r.physicianId} (${alt(r.physicianId)})`);
  para(
    `Alternative "calls include ringing" would disagree for: ${altDiff.length === 0 ? 'nobody' : altDiff.join(', ')}. ` +
      'Unclear columns: none of the snapshot columns failed a derivation; residual ambiguity (precedence of overlapping signals, ' +
      'phone-only Note Pending entry, ringing duration) is logged in docs/OPEN_QUESTIONS.md.',
  );
}

function checkTable(checks: readonly [string, string, number, string[]][], total: number): void {
  table(
    ['column', 'proposed derivation', 'rows matching', 'mismatches'],
    checks.map(([col, how, ok, mism]) => [`\`${col}\``, how, `${ok}/${total}`, mism.length === 0 ? '' : mism.join('; ')]),
  );
}

function coverageAndBaselineSection(d: Dataset): void {
  heading(2, 'Coverage requirements and baseline volume: time semantics');
  const blocks = [...new Set(d.coverageRequirements.map((c) => c.timeBlockEt.raw))];
  const reqCounts = groupBy(d.coverageRequirements, (c) => String(c.minAvailableCredentialedPhysicians));
  para(
    `**coverage_requirements.csv**: the header names the block column \`time_block_et\`, so blocks are ET wall-clock. ` +
      `Distinct blocks: ${blocks.map(code).join(', ')}; each hospital has ${d.coverageRequirements.length / Math.max(1, d.hospitals.length)} blocks ` +
      `that tile 24 h (the loader warns otherwise). A block whose end is before its start wraps midnight. ` +
      `Requirement values: ${[...reqCounts].map(([v, l]) => `${v} (${l.length} rows)`).join(', ')}. ` +
      'Boundary ownership (is 16:00 in the first or second block?) and the meaning of "available" are not stated: OQ-01, OQ-02.',
  );
  const tierA = new Set(d.hospitals.filter((h) => h.coverageTier === 'A').map((h) => h.hospitalId));
  const req2 = [...new Set(d.coverageRequirements.filter((c) => c.minAvailableCredentialedPhysicians >= 2).map((c) => c.hospitalId))];
  para(
    `Hospitals with a requirement of 2+ in any block: ${req2.join(', ') || 'none'}; coverage_tier "A" hospitals: ${[...tierA].join(', ') || 'none'}. ` +
      `${req2.length === tierA.size && req2.every((h) => tierA.has(h)) ? 'They coincide (tier A = higher daytime requirement).' : 'They do not coincide.'}`,
  );

  const dows = [...new Set(d.baselineHourly.map((b) => b.dowType))];
  const weeks = [...new Set(d.baselineHourly.map((b) => b.weeksSampled))];
  const means = d.baselineHourly.map((b) => b.meanConsults);
  const p90s = d.baselineHourly.map((b) => b.p90Consults);
  para(
    `**baseline_hourly_volume.csv**: the header names the hour column \`hour_start_et\`, so hours are ET. dow_type values: ${dows.map(code).join(', ')}; ` +
      `weeks_sampled: ${weeks.join(', ')}; mean_consults range ${Math.min(...means)}–${Math.max(...means)}; p90_consults range ${Math.min(...p90s)}–${Math.max(...p90s)} ` +
      '(p90 values are whole numbers). Each row is read as consults received in [hour_start, hour_start + 1 h) ET.',
  );
  const lastEvent = d.events.reduce((a, b) => (b.eventTime > a.eventTime ? b : a));
  const peakRows = d.hospitals.map((h) => {
    const rows = d.baselineHourly.filter((b) => b.hospitalId === h.hospitalId);
    const peak = rows.length === 0 ? null : rows.reduce((a, b) => (b.meanConsults > a.meanConsults ? b : a));
    const local = peak === null ? '' : DateTime.fromMillis(etWallClockToEpoch(etDateOf(lastEvent.eventTime), peak.hourStartEt.secondOfDay), { zone: ET_ZONE }).setZone(h.localTimezone).toFormat('HH:mm');
    return [h.hospitalId, h.localTimezone, peak?.hourStartEt.raw ?? '', local, peak?.meanConsults ?? ''];
  });
  para('First peak hour of mean_consults per hospital, in ET and converted to the hospital\'s local zone:');
  table(['hospital', 'local zone', 'peak hour (ET)', 'same instant, local', 'mean at peak'], peakRows);
  para(
    'Every hospital peaks at the same ET hour whatever its zone, which fits the header: buckets are ET, not hospital-local. ' +
      'OQ-03 keeps ET as the default.',
  );
  if (d.snapshot !== null) {
    const m = /^(\d{2})(\d{2})$/.exec(d.snapshot.label);
    if (m !== null) {
      const now = etWallClockToEpoch(etDateOf(lastEvent.eventTime), Number(m[1]) * 3600 + Number(m[2]) * 60);
      const hourSec = Number(m[1]) * 3600;
      const received = dedupe(d.events).kept.filter((e) => e.eventType === 'consult_received' && e.eventTime > now - 3_600_000 && e.eventTime <= now);
      const rows = d.hospitals.map((h) => {
        const n = received.filter((e) => e.hospitalId === h.hospitalId).length;
        const base = d.baselineHourly.find((b) => b.hospitalId === h.hospitalId && b.hourStartEt.secondOfDay === hourSec);
        return [h.hospitalId, n, base?.meanConsults ?? '', base?.p90Consults ?? '', base !== undefined && n > base.p90Consults ? 'above p90' : ''];
      });
      para(
        `Semantics illustration only (not the detector): consult_received count in the trailing 60 min to now (${et(now, 'HH:mm')} ET) ` +
          `vs the baseline row for hour ${m[1]}:00 ET.`,
      );
      table(['hospital', 'received (now-60m, now]', 'mean', 'p90', 'vs p90'], rows);
    }
  }
}

function rosterSection(d: Dataset): void {
  heading(2, 'Off-shift roster: fields vs eligibility rules');
  const cols = new Set(readCsvColumns(DATASET_FILES.offShiftRoster));
  const need: [string, string][] = [
    ['opt-in ("They have opted in to split-shift offers")', 'split_shift_opt_in'],
    ['last shift end ("At least 10 hours have passed since their last shift ended")', 'last_shift_end'],
    ['next shift start ("does not overlap a shift they are already scheduled for")', 'next_shift_start'],
    ['hours in trailing 7 days ("Hours worked in the trailing 7 days plus the offered hours do not exceed 60")', 'hours_worked_last_7d'],
    ['minutes to come online ("The estimated time to come online counts against the value of the offer")', 'est_minutes_to_online'],
    ['channel (offer delivery)', 'preferred_channel'],
    ['declines (ranking signal; not an eligibility rule)', 'offers_declined_last_30d'],
    ['role (Day / Night / Float)', 'role'],
  ];
  table(
    ['needed for', 'column', 'present'],
    need.map(([why, col]) => [why, `\`${col}\``, yes(cols.has(col))]),
  );
  para(
    'Missing for the rules in the brief: (1) offers already sent this week ("no more than 3 offers per physician per week"): no column, ' +
      'and `offers_declined_last_30d` is a 30-day decline count, not a weekly offer count (OQ-09); (2) open offers per physician: no column ' +
      '(our offer log is the source); (3) next shift end: not needed if an offer must end by next_shift_start (OQ-21); ' +
      `(4) physicians_on_shift.csv has no role column, so day/night for the routing low-volume threshold must be inferred (OQ-10). ` +
      `Roster roles present: ${[...new Set(d.offShiftRoster.map((r) => r.role))].map(code).join(', ')}; opt-in: ` +
      `${d.offShiftRoster.filter((r) => r.splitShiftOptIn).length} Yes / ${d.offShiftRoster.filter((r) => !r.splitShiftOptIn).length} No.`,
  );
  para(
    `physicians_on_shift.csv \`split_shift_opt_in\` values: ${[...new Set(d.physiciansOnShift.map((p) => p.splitShiftOptIn))].map(code).join(', ')} ` +
      '(not a Yes/No; kept verbatim).',
  );
}

function readCsvColumns(name: string): string[] {
  return [...readCsvFile(join(dataDir, name), name).header];
}

main();
