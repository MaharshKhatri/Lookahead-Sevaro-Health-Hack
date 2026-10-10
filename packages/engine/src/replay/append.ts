import { DateTime } from 'luxon';
import { readCsvText, type CsvTable } from '../data/csv';
import { DataParseError } from '../data/errors';
import { mapEventRow, pendingEventSchema, type PendingEvent } from '../data/events';
import { columnsOf, eventStreamSchema } from '../data/schemas';
import { ET_ZONE } from '../time';
import type { Dataset, EpochMs, EventType, RawEvent } from '../types';
import { payloadKey } from './normalize';

/** event_stream.csv columns, in file order. */
export const EVENT_COLUMNS = columnsOf(eventStreamSchema);

export interface RowError {
  readonly line: number;
  readonly reason: string;
}

export interface ParsedEventRows {
  readonly events: readonly PendingEvent[];
  readonly errors: readonly RowError[];
  readonly header: 'present' | 'absent';
}

export interface ParseEventRowsOptions {
  /** Alternate header name -> event_stream.csv column name. */
  readonly mapping?: Readonly<Record<string, string>>;
  readonly fileName?: string;
}

/**
 * Parses pasted or uploaded event rows in the event_stream.csv format, with or
 * without the header line (header-less lines must have exactly the file's 8
 * cells). ingested_at may be blank; appendEvents fills it. Bad lines become
 * per-line errors instead of failing the whole input.
 */
export function parseEventRows(text: string, opts: ParseEventRowsOptions = {}): ParsedEventRows {
  const file = opts.fileName ?? 'appended events';
  const mapping = opts.mapping ?? {};
  const canonical = (h: string) => mapping[h] ?? h;
  const header = looksLikeHeader(text, canonical) ? 'present' : 'absent';
  let table: CsvTable;
  try {
    table =
      header === 'present'
        ? readCsvText(file, text, { relaxColumnCount: true })
        : readCsvText(file, text, { columns: EVENT_COLUMNS, relaxColumnCount: true });
  } catch (err) {
    const line = err instanceof DataParseError ? (err.line ?? 1) : 1;
    return { events: [], errors: [{ line, reason: err instanceof Error ? err.message : String(err) }], header };
  }
  const names = table.header.map(canonical);
  const missing = EVENT_COLUMNS.filter((c) => c !== 'ingested_at' && !names.includes(c));
  if (missing.length > 0) return { events: [], errors: [{ line: 1, reason: `missing column(s): ${missing.join(', ')}` }], header };

  const events: PendingEvent[] = [];
  const errors: RowError[] = [];
  for (const row of table.rows) {
    if (row.cellCount !== table.header.length) {
      errors.push({ line: row.line, reason: `expected ${table.header.length} cells, got ${row.cellCount}` });
      continue;
    }
    const values: Record<string, string> = { ingested_at: '' };
    table.header.forEach((h) => {
      values[canonical(h)] = row.values[h] ?? '';
    });
    const parsed = pendingEventSchema.safeParse(values);
    if (!parsed.success) {
      const reason = parsed.error.issues.map((i) => `column "${String(i.path[0] ?? '?')}" value "${values[String(i.path[0] ?? '')] ?? ''}": ${i.message}`).join('; ');
      errors.push({ line: row.line, reason });
      continue;
    }
    events.push(mapEventRow(parsed.data, { rowIndex: row.rowIndex, line: row.line }, values));
  }
  return { events, errors, header };
}

function looksLikeHeader(text: string, canonical: (h: string) => string): boolean {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const cells = first.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  return cells.some((c) => (EVENT_COLUMNS as readonly string[]).includes(canonical(c)));
}

/**
 * Columns each event type needs to be applied, from the reference stream:
 * consult_id is blank only on physician-signal events, physician_id only on
 * consult_received / consult_triaged / routing_attempt_failed (docs/DATA_PROFILE.md).
 */
const NO_CONSULT: ReadonlySet<EventType> = new Set(['physician_status_changed', 'camera_active', 'camera_inactive', 'agent_heartbeat_lost', 'shift_started']);
const NO_PHYSICIAN: ReadonlySet<EventType> = new Set(['consult_received', 'consult_triaged', 'routing_attempt_failed']);

export interface AppendResult {
  readonly dataset: Dataset;
  readonly accepted: readonly RawEvent[];
  readonly duplicates: readonly { readonly line: number; readonly eventId: string; readonly reason: string }[];
  readonly rejected: readonly RowError[];
  readonly warnings: readonly string[];
  /** Events that arrived without ingested_at and were stamped with nowMs. */
  readonly ingestedAtDefaulted: readonly { readonly line: number; readonly eventId: string }[];
}

/**
 * Appends events to a dataset without mutating it. Duplicates (OQ-04) are
 * skipped; unknown hospital/physician IDs are accepted with a warning; events
 * missing a column their type needs are rejected. ingested_at defaults to nowMs.
 */
export function appendEvents(dataset: Dataset, newEvents: readonly PendingEvent[], opts: { readonly nowMs: EpochMs }): AppendResult {
  const hospitals = new Set(dataset.hospitals.map((h) => h.hospitalId));
  const physicians = new Set([...dataset.physiciansOnShift, ...dataset.offShiftRoster, ...dataset.credentials].map((p) => p.physicianId));
  const byId = new Map<string, RawEvent[]>();
  for (const e of dataset.events) byId.set(e.eventId, [...(byId.get(e.eventId) ?? []), e]);

  const accepted: RawEvent[] = [];
  const duplicates: AppendResult['duplicates'][number][] = [];
  const rejected: RowError[] = [];
  const warnings: string[] = [];
  const ingestedAtDefaulted: AppendResult['ingestedAtDefaulted'][number][] = [];

  for (const pending of newEvents) {
    const missing = requiredMissing(pending);
    if (missing.length > 0) {
      rejected.push({ line: pending.line, reason: `${pending.eventType} requires ${missing.join(', ')}` });
      continue;
    }
    const e = stampIngestion(pending, opts.nowMs, dataset.events.length + accepted.length);
    const sameId = byId.get(e.eventId) ?? [];
    if (sameId.some((x) => payloadKey(x) === payloadKey(e))) {
      duplicates.push({ line: e.line, eventId: e.eventId, reason: 'same event_id and content as an existing event (OQ-04)' });
      continue;
    }
    if (sameId.length > 0) warnings.push(`${e.eventId}: event_id already used with different content; accepted (OQ-04 conflict)`);
    if (e.hospitalId !== null && !hospitals.has(e.hospitalId)) warnings.push(`${e.eventId}: unknown hospital_id ${e.hospitalId}`);
    if (e.physicianId !== null && !physicians.has(e.physicianId)) warnings.push(`${e.eventId}: unknown physician_id ${e.physicianId}`);
    if (e.eventTime > e.ingestedAt) warnings.push(`${e.eventId}: event_time is after ingested_at`);
    if (pending.ingestedAt === null) ingestedAtDefaulted.push({ line: e.line, eventId: e.eventId });
    accepted.push(e);
    byId.set(e.eventId, [...sameId, e]);
  }
  return {
    dataset: { ...dataset, events: [...dataset.events, ...accepted], warnings: [...dataset.warnings, ...warnings] },
    accepted,
    duplicates,
    rejected,
    warnings,
    ingestedAtDefaulted,
  };
}

/** parseEventRows + appendEvents; parse errors are reported as rejections. */
export function appendEventText(
  dataset: Dataset,
  text: string,
  opts: ParseEventRowsOptions & { readonly nowMs: EpochMs },
): AppendResult & { readonly header: 'present' | 'absent' } {
  const parsed = parseEventRows(text, opts);
  const result = appendEvents(dataset, parsed.events, { nowMs: opts.nowMs });
  const rejected = [...parsed.errors, ...result.rejected].sort((a, b) => a.line - b.line);
  return { ...result, rejected, header: parsed.header };
}

function requiredMissing(e: PendingEvent): string[] {
  const missing: string[] = [];
  if (!NO_CONSULT.has(e.eventType) && e.consultId === null) missing.push('consult_id');
  if (!NO_PHYSICIAN.has(e.eventType) && e.physicianId === null) missing.push('physician_id');
  if (e.eventType === 'consult_received' && e.hospitalId === null) missing.push('hospital_id');
  return missing;
}

function stampIngestion(e: PendingEvent, nowMs: EpochMs, rowIndex: number): RawEvent {
  if (e.ingestedAt !== null) return { ...e, ingestedAt: e.ingestedAt, rowIndex };
  const raw = DateTime.fromMillis(nowMs, { zone: ET_ZONE }).toISO({ suppressMilliseconds: true }) ?? '';
  return { ...e, ingestedAt: nowMs, ingestedAtRaw: raw, rowIndex };
}
