import type { z } from 'zod';
import type { EpochMs, RawEvent, RowSource } from '../types';
import { optionalInstant } from './fields';
import { eventStreamSchema } from './schemas';

/**
 * event_stream.csv rows for live append: identical to the file schema except
 * that ingested_at may be blank (the caller supplies the ingestion instant).
 */
export const pendingEventSchema = eventStreamSchema.extend({ ingested_at: optionalInstant });

/** An event row before its ingestion instant is known. */
export type PendingEvent = Omit<RawEvent, 'ingestedAt'> & { readonly ingestedAt: EpochMs | null };

/** The one place event_stream.csv columns map to RawEvent fields (CLAUDE.md rule 2). */
export function mapEventRow(
  r: z.output<typeof pendingEventSchema>,
  src: RowSource,
  raw: Readonly<Record<string, string>>,
): PendingEvent {
  return {
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
  };
}
