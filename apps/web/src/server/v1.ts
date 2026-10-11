import 'server-only';
import { LATE_EVENT_FLAG_LAG_MS } from '@lookahead/engine';
import type { AttentionDTO, CoverageGridDTO, DemandChipDTO, StandbyDTO, SurgeForecastDTO, ViewDTO } from '@/lib/dto';
import { demoMode } from './auth';
import { V1_SCHEMA_VERSION, sameString as same, signBody } from './sign';
import { type InjectResult, StoreError, csvRow } from './store';

/**
 * Public v1 API (Phase 8, D-96): the integration surface a partner system
 * (Synapse AI event feed, OneCall, a BI tool) would call. Everything here is
 * a thin, versioned reshaping of what the Command Center already computes:
 *  - POST /api/v1/events: Sevaro event rows (JSON array or event_stream.csv
 *    text), HMAC-SHA256 signed over the raw body with LOOKAHEAD_INGEST_SECRET
 *    (`x-lookahead-signature: sha256=<hex>`), idempotent on event_id (OQ-04
 *    dedupe), answered with an IngestReport.
 *  - GET /api/v1/{forecast,standby,coverage,alerts,incidents}: read models,
 *    each stamped schemaVersion "1.0", asOfMs (the sim clock) and the dataset
 *    version. Open in DEMO_MODE; otherwise LOOKAHEAD_API_KEY as a bearer token.
 * Nothing in these payloads carries a phone-link token: standbyPath and offer
 * links are stripped (the link IS the physician's credential, D-78).
 */

export { V1_SCHEMA_VERSION, signBody };
export const SIGNATURE_HEADER = 'x-lookahead-signature';
export const API_KEY_HEADER = 'x-lookahead-api-key';
export const INGEST_SECRET_ENV = 'LOOKAHEAD_INGEST_SECRET';
export const API_KEY_ENV = 'LOOKAHEAD_API_KEY';

/** event_stream.csv columns, in file order (CLAUDE.md rule 2: names match the file exactly). */
export const EVENT_COLUMNS = ['event_id', 'event_time', 'ingested_at', 'consult_id', 'event_type', 'physician_id', 'hospital_id', 'description'] as const;
export type EventColumn = (typeof EVENT_COLUMNS)[number];

// ------------------------------------------------------------------ signing

const envValue = (name: string): string | null => {
  const v = process.env[name];
  return v === undefined || v === '' ? null : v;
};

export const ingestSecret = (): string | null => envValue(INGEST_SECRET_ENV);

export type SignatureVerdict = 'verified' | 'unsigned_demo';

/**
 * With LOOKAHEAD_INGEST_SECRET set, every request must carry a valid
 * signature (401 BAD_SIGNATURE otherwise, in every mode). Without a secret the
 * endpoint is open only in DEMO_MODE (verdict "unsigned_demo"); with
 * DEMO_MODE=false it answers 503 NOT_CONFIGURED rather than accept unsigned rows.
 */
export function verifySignature(raw: string, header: string | null): SignatureVerdict {
  const secret = ingestSecret();
  if (secret === null) {
    if (demoMode()) return 'unsigned_demo';
    throw new StoreError('NOT_CONFIGURED', `${INGEST_SECRET_ENV} is not set and DEMO_MODE is off: unsigned event pushes are refused`);
  }
  if (header === null || header.trim() === '') throw new StoreError('BAD_SIGNATURE', `missing ${SIGNATURE_HEADER} (sha256=<hex of HMAC-SHA256 over the raw body>)`);
  if (!same(header.trim(), signBody(secret, raw))) throw new StoreError('BAD_SIGNATURE', 'signature does not match the body');
  return 'verified';
}

/** Read endpoints: open in DEMO_MODE; otherwise `authorization: Bearer <LOOKAHEAD_API_KEY>` or x-lookahead-api-key. */
export function requireApiRead(req: Request): void {
  if (demoMode()) return;
  const key = envValue(API_KEY_ENV);
  if (key === null) throw new StoreError('NOT_CONFIGURED', `${API_KEY_ENV} is not set and DEMO_MODE is off: the v1 read API is closed`);
  const auth = req.headers.get('authorization') ?? '';
  const presented = req.headers.get(API_KEY_HEADER) ?? (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '');
  if (presented === '' || !same(presented, key)) throw new StoreError('API_KEY_REQUIRED', `send ${API_KEY_ENV} as a bearer token or in ${API_KEY_HEADER}`);
}

// ------------------------------------------------------------------ body -> event_stream.csv text

export type BodyFormat = 'csv' | 'json';

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * JSON bodies are an array of objects keyed by event_stream.csv column names
 * (or {events: [...]}); they are rendered to CSV text with a header so the
 * engine's own parser validates them (one code path, D-96). A key that is not
 * a column is a 400: silently dropping fields would hide a mapping error.
 */
export function bodyToCsv(raw: string, contentType: string): { readonly text: string; readonly format: BodyFormat; readonly rows: number | null } {
  if (!contentType.toLowerCase().includes('application/json')) return { text: raw, format: 'csv', rows: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StoreError('BAD_REQUEST', `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const list = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { events?: unknown }).events) ? (parsed as { events: unknown[] }).events : null;
  if (list === null) throw new StoreError('BAD_REQUEST', 'JSON body must be an array of event objects or {"events": [...]}');
  const lines = [EVENT_COLUMNS.join(',')];
  list.forEach((row, i) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new StoreError('BAD_REQUEST', `events[${i}] must be an object keyed by event_stream.csv columns`);
    const unknown = Object.keys(row).filter((k) => !(EVENT_COLUMNS as readonly string[]).includes(k));
    if (unknown.length > 0) throw new StoreError('BAD_REQUEST', `events[${i}] has unknown field(s): ${unknown.join(', ')}; columns are ${EVENT_COLUMNS.join(', ')}`);
    const r = row as Partial<Record<EventColumn, unknown>>;
    lines.push(EVENT_COLUMNS.map((c) => csvCell(r[c])).join(','));
  });
  return { text: lines.join('\n'), format: 'json', rows: list.length };
}

// ------------------------------------------------------------------ ingest report

export interface IngestReportDTO {
  readonly schemaVersion: typeof V1_SCHEMA_VERSION;
  readonly ok: boolean;
  readonly signature: SignatureVerdict;
  readonly format: BodyFormat;
  /** Sim clock the rows were appended at (ingested_at defaults to it when absent). */
  readonly nowMs: number;
  readonly accepted: number;
  readonly duplicates: number;
  /** Accepted rows whose ingested_at trails event_time by more than LATE_EVENT_FLAG_LAG_MS (OQ-12): replay orders them by event_time anyway. */
  readonly late: number;
  /** `row` is the CSV line (header = 1) for text bodies, the array index for JSON bodies. */
  readonly rejected: readonly { readonly row: number; readonly reason: string }[];
  readonly rowBasis: 'line' | 'index';
  readonly acceptedEventIds: readonly string[];
  readonly duplicateEventIds: readonly string[];
  readonly warnings: readonly string[];
  /** When accepted rows are dated after the sim clock: the instant they all become known (knowledge time, D-20). */
  readonly knownFromMs: number | null;
}

export function ingestReport(r: InjectResult, signature: SignatureVerdict, format: BodyFormat): IngestReportDTO {
  const toRow = (line: number) => (format === 'json' ? Math.max(0, line - 2) : line);
  return {
    schemaVersion: V1_SCHEMA_VERSION,
    ok: r.rejected.length === 0,
    signature,
    format,
    nowMs: r.nowMs,
    accepted: r.accepted.length,
    duplicates: r.duplicates.length,
    late: r.accepted.filter((e) => e.ingestedAtMs - e.eventTimeMs > LATE_EVENT_FLAG_LAG_MS).length,
    rejected: r.rejected.map((x) => ({ row: toRow(x.line), reason: x.reason })),
    rowBasis: format === 'json' ? 'index' : 'line',
    acceptedEventIds: r.accepted.map((e) => e.eventId),
    duplicateEventIds: r.duplicates.map((d) => d.eventId),
    warnings: r.warnings,
    knownFromMs: r.knownFromMs,
  };
}

// ------------------------------------------------------------------ read models

interface Envelope {
  readonly schemaVersion: typeof V1_SCHEMA_VERSION;
  readonly asOfMs: number;
  readonly dataset: { readonly key: string; readonly label: string; readonly version: number };
}

const envelope = (view: ViewDTO): Envelope => ({
  schemaVersion: V1_SCHEMA_VERSION,
  asOfMs: view.clock.nowMs,
  dataset: { key: view.dataset.key, label: view.dataset.label, version: view.version },
});

export type V1Forecast = Envelope & { readonly params: SurgeForecastDTO['params']; readonly hospitals: SurgeForecastDTO['hospitals'] };

export function v1Forecast(view: ViewDTO): V1Forecast {
  return { ...envelope(view), params: view.forecast.params, hospitals: [...view.forecast.hospitals].sort((a, b) => a.riskRank - b.riskRank) };
}

/** A standby without its phone link (the link is the physician's credential) and without the per-candidate ledger (GET /api/standby has it). */
export type V1Standby = Omit<StandbyDTO, 'standbyPath' | 'candidates' | 'allowedActions'>;

export type V1StandbyPlan = Envelope & { readonly plan: ViewDTO['standby']['plan']; readonly standbys: readonly V1Standby[] };

export function v1Standby(view: ViewDTO): V1StandbyPlan {
  const standbys = view.standby.standbys.map((s) => {
    const { standbyPath, candidates, allowedActions, ...rest } = s;
    void standbyPath;
    void candidates;
    void allowedActions;
    return rest;
  });
  return { ...envelope(view), plan: view.standby.plan, standbys };
}

export type V1Coverage = Envelope & {
  readonly bucketMin: CoverageGridDTO['bucketMin'];
  readonly detectionHorizonEndMs: number;
  readonly horizonEndMs: number;
  readonly hospitals: readonly {
    readonly hospitalId: string;
    readonly hospitalName: string;
    readonly worst: CoverageGridDTO['rows'][number]['worst'];
    readonly routableNow: number;
    readonly cells: readonly { readonly startMs: number; readonly endMs: number; readonly required: number; readonly staffedConfirmed: number; readonly staffedExpected: number; readonly class: string; readonly pGap: number | null }[];
  }[];
  readonly demand: readonly DemandChipDTO[];
  readonly shiftChanges: CoverageGridDTO['markers'];
};

export function v1Coverage(view: ViewDTO): V1Coverage {
  const g = view.coverage;
  return {
    ...envelope(view),
    bucketMin: g.bucketMin,
    detectionHorizonEndMs: g.detectionHorizonEndMs,
    horizonEndMs: g.horizonEndMs,
    hospitals: g.rows.map((r) => ({
      hospitalId: r.hospitalId,
      hospitalName: r.hospitalName,
      worst: r.worst,
      routableNow: r.routableNow,
      cells: r.cells.map((c) => ({ startMs: c.startMs, endMs: c.endMs, required: c.required, staffedConfirmed: c.staffedConfirmed, staffedExpected: c.staffedExpected, class: c.class, pGap: c.pGap ?? null })),
    })),
    demand: view.demand,
    shiftChanges: g.markers,
  };
}

export type V1Alert = Pick<AttentionDTO, 'rank' | 'id' | 'kind' | 'severity' | 'strokeAtRisk' | 'headline' | 'timeToImpactMs' | 'score' | 'why' | 'consultIds' | 'hospitalIds' | 'physicianIds'> & { readonly evidenceEventIds: readonly string[] };

export type V1Alerts = Envelope & { readonly alerts: readonly V1Alert[]; readonly critical: number };

export function v1Alerts(view: ViewDTO): V1Alerts {
  const alerts = view.attention.map((a) => ({
    rank: a.rank,
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    strokeAtRisk: a.strokeAtRisk,
    headline: a.headline,
    timeToImpactMs: a.timeToImpactMs,
    score: a.score,
    why: a.why,
    consultIds: a.consultIds,
    hospitalIds: a.hospitalIds,
    physicianIds: a.physicianIds,
    evidenceEventIds: a.because.map((e) => e.eventId),
  }));
  return { ...envelope(view), alerts, critical: alerts.filter((a) => a.severity === 'critical').length };
}

export type V1Incidents = Envelope & { readonly incidents: ViewDTO['intel']['incidents']; readonly reduction: ViewDTO['intel']['reduction']; readonly nextBestActions: ViewDTO['intel']['nextBestActions']; readonly timeline: ViewDTO['intel']['timeline'] };

export function v1Incidents(view: ViewDTO): V1Incidents {
  return { ...envelope(view), incidents: view.intel.incidents, reduction: view.intel.reduction, nextBestActions: view.intel.nextBestActions, timeline: view.intel.timeline };
}

/** Re-exported so the route can echo accepted rows back as event_stream.csv lines if a caller asks (`?echo=csv`). */
export { csvRow };
