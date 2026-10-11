import 'server-only';
import * as eventsRoute from '@/app/api/v1/events/route';
import type { ViewDTO } from '@/lib/dto';
import { type IngestReportDTO, EVENT_COLUMNS, SIGNATURE_HEADER, ingestSecret } from './v1';
import { sameString, signBody } from './sign';
import { StoreError, type StoreSnapshot, getReadyStore } from './store';
import { computeView, nextId } from './view';
import { SIMULATOR_SINK_PATH, simulatorEnabled, webhookConfig } from './webhooks';

/**
 * Upstream Event Simulator (sprint B1, demo only; LOOKAHEAD-DEFINED). Stands
 * in for a Synapse-style event feed: every button builds one event_stream.csv
 * row from the CURRENT snapshot (sim clock, open consults, on-shift
 * physicians, hospitals), signs the raw body with LOOKAHEAD_INGEST_SECRET when
 * one is set (the browser never sees the secret) and posts it through the real
 * POST /api/v1/events handler in-process, so the row takes exactly the path a
 * partner integration's row would (signature check, OQ-04 dedupe, OQ-12 late
 * flag, IngestReport). Event types and description wording are the ones in
 * data/raw/event_stream.csv (CLAUDE.md rule 2); generated ids are the next free
 * id of the same shape as the largest in use, never hard-coded (rule 5).
 *
 * Enabled with SIMULATOR_ENABLED=1, on by default in DEMO_MODE
 * (SIMULATOR_ENABLED=0 turns it off); otherwise the routes answer 404.
 */

export { SIMULATOR_SINK_PATH, simulatorEnabled };

export const SIM_KINDS = ['stroke_consult', 'physician_status', 'camera_active', 'heartbeat_lost', 'note_signed', 'routing_failed', 'duplicate', 'late'] as const;
export type SimKind = (typeof SIM_KINDS)[number];
export const isSimKind = (v: unknown): v is SimKind => typeof v === 'string' && (SIM_KINDS as readonly string[]).includes(v);

/** Self-reported statuses the simulator can send (wording as in event_stream.csv "Self-reported status: <value>"). */
export const SIM_STATUSES = ['Available', 'Temporarily Unavailable'] as const;
export type SimStatus = (typeof SIM_STATUSES)[number];

/** The late-event button: event_time this long before ingested_at (sprint B1; above LATE_EVENT_FLAG_LAG_MS, OQ-12). */
export const SIM_LATE_LAG_MS = 7 * 60_000;
/** Ordinary rows: event_time this long before ingested_at (the reference stream shows 1-4 s of ingestion lag). */
export const SIM_INGEST_LAG_MS = 2_000;
export const SINK_LOG_SIZE = 50;
/** Rate-limit key for in-process posts: the simulator gets its own events bucket, not the operator's. */
export const SIM_CLIENT_KEY = 'upstream-simulator';

// Description wording copied from data/raw/event_stream.csv.
const DESC = {
  consult_received: 'Stroke consult request received',
  camera_active: 'Desktop agent: camera active',
  agent_heartbeat_lost: 'Desktop presence agent stopped reporting',
  note_signed: 'Note signed; consult signed off',
  routing_attempt_failed: 'No available credentialed provider; retry scheduled',
} as const;

export interface SimSendInput {
  readonly kind: SimKind;
  readonly hospitalId?: string;
  readonly physicianId?: string;
  readonly status?: string;
}

export interface SimSendResult {
  readonly kind: SimKind;
  readonly sentAtMs: number;
  /** Exactly the body posted to /api/v1/events (event_stream.csv text with header). */
  readonly payload: string;
  readonly contentType: 'text/csv';
  /** x-lookahead-signature sent, or null when unsigned (no ingest secret, DEMO_MODE). */
  readonly signatureHeader: string | null;
  readonly status: number;
  readonly report: IngestReportDTO | { readonly ok: false; readonly code: string; readonly message: string };
  readonly latencyMs: number;
  /** Store version after the post: the first webhook envelope with version >= this one carries the change. */
  readonly version: number;
  readonly simNowMs: number;
  readonly summary: string;
}

export interface SinkEntry {
  readonly receivedAtMs: number;
  /** true/false when a webhook secret is configured; null when deliveries are unsigned (nothing to verify against). */
  readonly verified: boolean | null;
  readonly signature: string | null;
  readonly version: number | null;
  readonly body: unknown;
}

interface SimState {
  lastSentAtMs: number | null;
  lastPayload: string | null;
  lastKind: SimKind | null;
  issuedEvents: Set<string>;
  issuedConsults: Set<string>;
  sink: SinkEntry[];
}

const holder = globalThis as unknown as { __lookaheadSimulator?: SimState };
const state = (): SimState => (holder.__lookaheadSimulator ??= { lastSentAtMs: null, lastPayload: null, lastKind: null, issuedEvents: new Set(), issuedConsults: new Set(), sink: [] });

/** Tests only. */
export function resetSimulatorState(): void {
  delete holder.__lookaheadSimulator;
}

export const lastSimulatorSentAtMs = (): number | null => state().lastSentAtMs;
export const sinkEntries = (): readonly SinkEntry[] => state().sink;

export function requireSimulator(): void {
  if (!simulatorEnabled()) throw new StoreError('NOT_FOUND', 'the upstream event simulator is disabled (set SIMULATOR_ENABLED=1, or run with DEMO_MODE)');
}

// ------------------------------------------------------------------ row building

/** ISO-8601 with the explicit offset of `zone` at that instant, e.g. 2026-03-17T18:20:00-04:00 (CLAUDE.md rule 4). */
export function isoInZone(ms: number, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offMin = Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** The zone the feed stamps rows in: the offset of the reference stream's own timestamps is ET (data/raw/event_stream.csv). */
const FEED_ZONE = 'America/New_York';

type Row = Record<(typeof EVENT_COLUMNS)[number], string>;

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (row: Row) => `${EVENT_COLUMNS.join(',')}\n${EVENT_COLUMNS.map((c) => cell(row[c])).join(',')}`;

function freshEventId(s: StoreSnapshot): string {
  const st = state();
  const id = nextId([...s.dataset.events.map((e) => e.eventId), ...st.issuedEvents], 'EVT-');
  st.issuedEvents.add(id);
  return id;
}

function freshConsultId(s: StoreSnapshot): string {
  const st = state();
  const ids = s.dataset.events.flatMap((e) => (e.consultId === null ? [] : [e.consultId]));
  const id = nextId([...ids, ...st.issuedConsults], 'CON-');
  st.issuedConsults.add(id);
  return id;
}

/** Default hospital: the forecast's top-risk hospital (surge radar order, D-85), else the first hospital. */
export function defaultHospitalId(view: ViewDTO, s: StoreSnapshot): string | null {
  const top = [...view.forecast.hospitals].sort((a, b) => a.riskRank - b.riskRank)[0];
  return top?.hospitalId ?? s.dataset.hospitals[0]?.hospitalId ?? null;
}

function pickHospital(input: SimSendInput, view: ViewDTO, s: StoreSnapshot): string {
  const known = new Set(s.dataset.hospitals.map((h) => h.hospitalId));
  if (input.hospitalId !== undefined && input.hospitalId !== '') {
    if (!known.has(input.hospitalId)) throw new StoreError('BAD_REQUEST', `unknown hospitalId ${input.hospitalId}`);
    return input.hospitalId;
  }
  const d = defaultHospitalId(view, s);
  if (d === null) throw new StoreError('INVALID_STATE', 'the dataset has no hospitals');
  return d;
}

function pickPhysician(input: SimSendInput, view: ViewDTO): string {
  if (input.physicianId !== undefined && input.physicianId !== '') {
    if (!view.physicians.some((p) => p.physicianId === input.physicianId)) throw new StoreError('BAD_REQUEST', `physician ${input.physicianId} is not on shift`);
    return input.physicianId;
  }
  const p = view.physicians[0];
  if (p === undefined) throw new StoreError('INVALID_STATE', 'no physician is on shift');
  return p.physicianId;
}

const newestFirst = (a: ViewDTO['consults'][number], b: ViewDTO['consults'][number]) => (a.minSinceReceived ?? Infinity) - (b.minSinceReceived ?? Infinity);

/**
 * Builds one row for `kind` from the current snapshot. Physician-signal rows
 * leave consult_id blank and consult-pipeline rows before assignment leave
 * physician_id blank, as the reference stream does (replay/append.ts).
 */
export function buildRow(input: SimSendInput, s: StoreSnapshot, view: ViewDTO): { readonly payload: string; readonly summary: string } {
  const now = s.clock.nowMs;
  const base = (eventTimeMs: number): Pick<Row, 'event_id' | 'event_time' | 'ingested_at'> => ({ event_id: freshEventId(s), event_time: isoInZone(eventTimeMs, FEED_ZONE), ingested_at: isoInZone(now, FEED_ZONE) });
  const blank = { consult_id: '', physician_id: '', hospital_id: '' };
  switch (input.kind) {
    case 'stroke_consult':
    case 'late': {
      const hospitalId = pickHospital(input, view, s);
      const consultId = freshConsultId(s);
      const lag = input.kind === 'late' ? SIM_LATE_LAG_MS : SIM_INGEST_LAG_MS;
      const row: Row = { ...base(now - lag), ...blank, consult_id: consultId, event_type: 'consult_received', hospital_id: hospitalId, description: DESC.consult_received };
      return { payload: toCsv(row), summary: `${input.kind === 'late' ? 'Late ' : ''}consult_received ${consultId} at ${hospitalId}${input.kind === 'late' ? ` (event_time ${SIM_LATE_LAG_MS / 60_000} min before ingested_at)` : ''}` };
    }
    case 'physician_status': {
      const status = input.status ?? SIM_STATUSES[0];
      if (!(SIM_STATUSES as readonly string[]).includes(status)) throw new StoreError('BAD_REQUEST', `status must be one of: ${SIM_STATUSES.join(', ')}`);
      const physicianId = pickPhysician(input, view);
      const row: Row = { ...base(now - SIM_INGEST_LAG_MS), ...blank, event_type: 'physician_status_changed', physician_id: physicianId, description: `Self-reported status: ${status}` };
      return { payload: toCsv(row), summary: `physician_status_changed ${physicianId} -> ${status}` };
    }
    case 'camera_active': {
      // "Camera active without a session": the camera comes on while the physician has no video_started (brief: desktop presence signals).
      const physicianId = pickPhysician(input, view);
      const hospitalId = pickHospital(input, view, s);
      const row: Row = { ...base(now - SIM_INGEST_LAG_MS), ...blank, event_type: 'camera_active', physician_id: physicianId, hospital_id: hospitalId, description: DESC.camera_active };
      return { payload: toCsv(row), summary: `camera_active ${physicianId} (no video session)` };
    }
    case 'heartbeat_lost': {
      const physicianId = pickPhysician(input, view);
      const row: Row = { ...base(now - SIM_INGEST_LAG_MS), ...blank, event_type: 'agent_heartbeat_lost', physician_id: physicianId, description: DESC.agent_heartbeat_lost };
      return { payload: toCsv(row), summary: `agent_heartbeat_lost ${physicianId}` };
    }
    case 'note_signed': {
      const open = view.consults.filter((c) => c.assigned !== null && c.stage !== 'Signed Off').sort(newestFirst);
      const c = open.find((x) => x.assigned === input.physicianId) ?? open[0];
      if (c === undefined || c.assigned === null) throw new StoreError('INVALID_STATE', 'no open assigned consult to sign off');
      const row: Row = { ...base(now - SIM_INGEST_LAG_MS), event_type: 'note_signed', consult_id: c.consultId, physician_id: c.assigned, hospital_id: c.hospitalId === '-' ? '' : c.hospitalId, description: DESC.note_signed };
      return { payload: toCsv(row), summary: `note_signed ${c.consultId} by ${c.assigned}` };
    }
    case 'routing_failed': {
      const waiting = view.consults.filter((c) => c.assigned === null && c.stage !== 'Signed Off').sort(newestFirst);
      const c = waiting.find((x) => x.hospitalId === input.hospitalId) ?? waiting[0];
      if (c === undefined) throw new StoreError('INVALID_STATE', 'no unassigned open consult to fail routing for; send a new stroke consult first');
      const row: Row = { ...base(now - SIM_INGEST_LAG_MS), ...blank, event_type: 'routing_attempt_failed', consult_id: c.consultId, hospital_id: c.hospitalId === '-' ? '' : c.hospitalId, description: DESC.routing_attempt_failed };
      return { payload: toCsv(row), summary: `routing_attempt_failed ${c.consultId}` };
    }
    case 'duplicate': {
      const last = state().lastPayload;
      if (last === null) throw new StoreError('INVALID_STATE', 'nothing sent yet: the duplicate button resends the last row');
      const lastKind = state().lastKind;
      return { payload: last, summary: lastKind === null ? 'duplicate of the last row' : `duplicate of the last ${lastKind} row` };
    }
  }
}

// ------------------------------------------------------------------ send

/** Builds, signs and posts one row through the real v1 events handler (in-process). */
export async function simulatorSend(input: SimSendInput): Promise<SimSendResult> {
  requireSimulator();
  const store = await getReadyStore();
  const s = store.snapshot();
  const { payload, summary } = buildRow(input, s, computeView(s));
  const secret = ingestSecret();
  const signatureHeader = secret === null ? null : signBody(secret, payload);
  const headers: Record<string, string> = { 'content-type': 'text/csv', 'x-forwarded-for': SIM_CLIENT_KEY, 'user-agent': 'lookahead-upstream-simulator/1.0' };
  if (signatureHeader !== null) headers[SIGNATURE_HEADER] = signatureHeader;
  const sentAtMs = Date.now();
  const started = performance.now();
  const res = await eventsRoute.POST(new Request('http://simulator.internal/api/v1/events', { method: 'POST', headers, body: payload }));
  const latencyMs = Math.round((performance.now() - started) * 10) / 10;
  const report = (await res.json()) as SimSendResult['report'];
  const st = state();
  st.lastSentAtMs = sentAtMs;
  if (input.kind !== 'duplicate') {
    st.lastPayload = payload;
    st.lastKind = input.kind;
  }
  const after = store.snapshot();
  return { kind: input.kind, sentAtMs, payload, contentType: 'text/csv', signatureHeader, status: res.status, report, latencyMs, version: after.version, simNowMs: after.clock.nowMs, summary };
}

// ------------------------------------------------------------------ dev webhook sink

/**
 * Records one inbound webhook delivery. With a webhook secret configured the
 * x-lookahead-signature must match HMAC-SHA256 over the raw body; a mismatch
 * is still stored (verified:false, so the log shows it) and answered 401 so
 * the dispatcher's delivery log records the failure (LOOKAHEAD-DEFINED).
 */
export function recordSinkDelivery(raw: string, signature: string | null, receivedAtMs: number): SinkEntry {
  const secret = webhookConfig().secret;
  const verified = secret === null ? null : signature !== null && sameString(signature.trim(), signBody(secret, raw));
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    // keep the raw text
  }
  const v = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined;
  const entry: SinkEntry = { receivedAtMs, verified, signature, version: typeof v === 'number' ? v : null, body };
  const st = state();
  st.sink.unshift(entry);
  st.sink.length = Math.min(st.sink.length, SINK_LOG_SIZE);
  return entry;
}
