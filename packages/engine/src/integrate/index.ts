import type { PendingEvent } from '../data/events';
import type { AppendResult } from '../replay/append';
import type { CredentialRow, Dataset, EpochMs, OffShiftPhysician, OnShiftPhysician, RawEvent } from '../types';

/**
 * Integration seams (Phase 8): pure interfaces the engine is fed through and
 * speaks out of. Nothing here does I/O; adapters live in apps/web
 * (`src/server/integrate/`). The mapping to Sevaro's products in
 * docs/INTEGRATION.md comes from their PUBLIC product descriptions; their
 * APIs are unknown to us and the brief puts real scheduling, credentialing
 * and messaging systems out of scope ("Out of Scope"). The engine therefore
 * depends only on these shapes, never on a vendor.
 */

/** Where Sevaro events come from: a CSV file (data package), an HTTP push (POST /api/v1/events), or a replay of a stored log. Maps to Synapse AI's telephony, video, imaging and documentation events. */
export interface EventSource {
  readonly kind: 'csv_file' | 'http_push' | 'stored_log';
  /** Rows in event_stream.csv order (brief: "Sorted by ingested_at"), parsed and validated by the engine's own parser. */
  readonly events: () => readonly PendingEvent[] | Promise<readonly PendingEvent[]>;
}

/** Shift schedule facts: who is on shift, who is scheduled to arrive (physicians_on_shift.csv, physicians_off_shift_roster.csv). Maps to Synapse AI scheduling. */
export interface ScheduleSource {
  readonly onShift: () => readonly OnShiftPhysician[];
  readonly offShift: () => readonly OffShiftPhysician[];
}

/** Credentialing facts (credentialing_matrix.csv). The brief models credentialing as given; changing it is strategic (weeks). */
export interface CredentialSource {
  readonly rows: () => readonly CredentialRow[];
  readonly hospitalIds: () => readonly string[];
}

/** A message to a physician or the coordinator. The text has already passed the PHI guard; channels never add content. */
export interface OutboundMessage {
  readonly messageId: string;
  readonly to: { readonly physicianId: string; readonly channel: string };
  readonly kind: 'offer' | 'standby_prealert' | 'standby_activation' | 'standby_release' | 'internal_alert';
  readonly text: string;
  readonly atMs: EpochMs;
}

export interface DeliveryReceipt {
  readonly messageId: string;
  readonly status: 'delivered' | 'failed' | 'suppressed';
  readonly detail: string;
  readonly atMs: EpochMs;
}

/** Simulated push / SMS, or a webhook. Maps to Triage by Sevaro (provider mobile app) for the roster channel "app_push". Every send must have been approved by the clinical lead first (brief). */
export interface NotificationChannel {
  readonly kind: 'simulated_push' | 'simulated_sms' | 'webhook';
  readonly send: (m: OutboundMessage) => DeliveryReceipt | Promise<DeliveryReceipt>;
}

/** Where the clinical lead's approval comes from: the phone inbox (/lead) or an external approval system. The approval is a person (brief figure 2). */
export interface ApprovalChannel {
  readonly kind: 'lead_inbox' | 'external';
  readonly requestApproval: (x: { readonly subjectId: string; readonly kind: 'offer' | 'standby' | 'activation' | 'escalation'; readonly summary: string }) => void | Promise<void>;
}

/** The engine's own ingest step, exposed as the function adapters call (replay/append.ts). */
export type IngestFn = (dataset: Dataset, events: readonly PendingEvent[], opts: { readonly nowMs: EpochMs }) => AppendResult;

/** What a stored-log replay hands back: the rows as accepted, in order. */
export type StoredRow = Pick<RawEvent, 'eventId' | 'eventTimeRaw' | 'ingestedAtRaw' | 'consultId' | 'eventType' | 'physicianId' | 'hospitalId' | 'description'>;
