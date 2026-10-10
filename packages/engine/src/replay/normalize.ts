import { LATE_EVENT_FLAG_LAG_MS } from '../policy';
import type { EpochMs, RawEvent } from '../types';
import type { DuplicateRecord, EventRef, LateEventRecord } from './types';

/** Every column except event_id and ingested_at (the OQ-04 payload). */
export function payloadKey(e: RawEvent): string {
  return [e.eventTime, e.consultId ?? '', e.eventType, e.physicianId ?? '', e.hospitalId ?? '', e.description].join('\u0000');
}

export function eventRef(e: RawEvent): EventRef {
  return { eventId: e.eventId, eventTimeMs: e.eventTime, eventType: e.eventType };
}

const byIngestThenFile = (a: RawEvent, b: RawEvent) => a.ingestedAt - b.ingestedAt || a.rowIndex - b.rowIndex;

/**
 * OQ-04: same event_id and identical payload (all columns except ingested_at)
 * is a duplicate; the earliest-ingested copy is kept. Same event_id with a
 * different payload is a data conflict: both are kept and a warning raised.
 * Kept events stay in their input order.
 */
export function dedupe(events: readonly RawEvent[]): {
  events: RawEvent[];
  duplicates: DuplicateRecord[];
  warnings: string[];
} {
  const firstById = new Map<string, RawEvent[]>();
  const dropped = new Set<RawEvent>();
  const duplicates: DuplicateRecord[] = [];
  const warnings: string[] = [];
  for (const e of [...events].sort(byIngestThenFile)) {
    const seen = firstById.get(e.eventId) ?? [];
    const same = seen.find((k) => payloadKey(k) === payloadKey(e));
    if (same !== undefined) {
      dropped.add(e);
      duplicates.push({
        kept: { eventId: same.eventId, line: same.line, ingestedAtMs: same.ingestedAt },
        dropped: { eventId: e.eventId, line: e.line, ingestedAtMs: e.ingestedAt },
        reason: 'same event_id and identical content except ingested_at (OQ-04); earliest-ingested copy kept',
      });
      continue;
    }
    if (seen.length > 0) {
      warnings.push(`${e.eventId}: event_id reused with different content (lines ${[...seen.map((k) => k.line), e.line].join(', ')}); both kept`);
    }
    firstById.set(e.eventId, [...seen, e]);
  }
  return { events: events.filter((e) => !dropped.has(e)), duplicates, warnings };
}

/**
 * Event-time order with a total, input-order-independent key:
 * (event_time, ingested_at, event_id, payload).
 */
export function orderByEventTime(events: readonly RawEvent[]): RawEvent[] {
  return [...events].sort(
    (a, b) =>
      a.eventTime - b.eventTime ||
      a.ingestedAt - b.ingestedAt ||
      (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0) ||
      (payloadKey(a) < payloadKey(b) ? -1 : payloadKey(a) > payloadKey(b) ? 1 : 0),
  );
}

/**
 * Knowledge-time view: what the system could know at `asOfMs` is exactly the
 * events ingested by then (brief: "Every event carries both event_time and
 * ingested_at. State built only from arrival order will be wrong.").
 */
export function knownAt(events: readonly RawEvent[], asOfMs: EpochMs): RawEvent[] {
  return events.filter((e) => e.ingestedAt <= asOfMs);
}

export function lagMs(e: RawEvent): number {
  return e.ingestedAt - e.eventTime;
}

/** OQ-12: flagged late when ingestion lag exceeds LATE_EVENT_FLAG_LAG_MS. */
export function isLate(e: RawEvent): boolean {
  return lagMs(e) > LATE_EVENT_FLAG_LAG_MS;
}

export function lateEvents(events: readonly RawEvent[]): LateEventRecord[] {
  return events.filter(isLate).map((e) => ({
    eventId: e.eventId,
    eventType: e.eventType,
    eventTimeMs: e.eventTime,
    ingestedAtMs: e.ingestedAt,
    lagMs: lagMs(e),
  }));
}
