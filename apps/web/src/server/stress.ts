import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { findPhiViolations, forecast, mulberry32, replay, seedFromString, type ActionEvent, type ActionLog, type ActorRef, type Rng } from '@lookahead/engine';
import type { AttentionDTO, ConsultRowDTO, PhysicianRowDTO, ViewDTO } from '@/lib/dto';
import { etHms } from '@/lib/format';
import { POST as commandsPOST } from '@/app/api/commands/route';
import { POST as eventsPOST } from '@/app/api/v1/events/route';
import { LEAD_COOKIE, ROLE_COOKIE, demoMode, leadCookieValue, roleSessionValue, standbyToken } from './auth';
import { fitFor } from './forecast';
import { etOffsetLabel, runGeneralization } from './mutate';
import { signBody } from './sign';
import { type Store, type StoreSnapshot, StoreError, csvRow, getReadyStore } from './store';
import { EVENT_COLUMNS, type IngestReportDTO, SIGNATURE_HEADER, ingestSecret } from './v1';
import { computeView } from './view';

/**
 * Stress harness (LOOKAHEAD-DEFINED; backs the Stress Test page). Each action
 * drives the REAL paths in-process: Sevaro rows go through the
 * POST /api/v1/events handler (HMAC-signed when LOOKAHEAD_INGEST_SECRET is
 * set; brief "What Teams Must Demonstrate" #8, live injection), decisions go
 * through the POST /api/commands handler with the role headers and the lead
 * cookie (brief "Users and Decision Rights"), and the result is read back from
 * computeView. Every run appends one automated internal alert (brief: "Automated
 * actions are permitted only for low-risk steps (for example, an internal alert
 * to the coordinator)") whose text passes the PHI guard. Ids for new events and
 * consults are generated from a counter and checked against the dataset; no
 * id is hard-coded. Failures inside an action are returned as ok:false with
 * the error text and counted, never thrown out of the route.
 */

// ------------------------------------------------------------------ contract

export type StressGroup = 'prove' | 'break';

export interface StressActionDef {
  readonly id: string;
  readonly group: StressGroup;
  readonly label: string;
  readonly description: string;
}

export interface StressResult {
  readonly id: string;
  readonly action: string;
  readonly group: StressGroup;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly startedAtMs: number;
  readonly summary: string;
  readonly details: readonly string[];
  readonly metrics: Readonly<Record<string, number | string>>;
  readonly error: string | null;
}

export interface StressTotals {
  readonly handled: number;
  readonly errors: number;
  readonly seconds: number;
  readonly byAction: Readonly<Record<string, number>>;
}

export const STRESS_ACTIONS: readonly StressActionDef[] = [
  { id: 'late_event', group: 'prove', label: 'Late event', description: 'A stage event for an open video consult arrives 7 minutes after it happened; replay orders it by event time and the stage timer counts from the event, not the arrival.' },
  { id: 'duplicate_flood', group: 'prove', label: 'Duplicate flood', description: 'Ten exact copies of an existing row are pushed within two seconds; every copy is ignored on event_id and the dataset does not grow.' },
  { id: 'deadlock_recovery', group: 'prove', label: 'Deadlock and recovery', description: 'An unassigned consult arrives at a hospital with no credentialed routable physician (a deadlock), then an assignment to a credentialed physician clears it.' },
  { id: 'trap_proof', group: 'prove', label: 'Split-shift trap', description: 'Routing outcome for the recommended offer, unscoped versus scoped and seeded, from the engine trap analysis of the routing rules.' },
  { id: 'generalization', group: 'prove', label: 'Generalization', description: 'A separate in-memory copy of the dataset with new ids, names, dates and row order gives the same verdicts once ids are mapped back; the live dataset is untouched.' },
  { id: 'deterministic_forecast', group: 'prove', label: 'Deterministic forecast', description: 'The surge forecast is computed three times for the same snapshot; the SHA-256 hashes of its stable JSON must be equal.' },
  { id: 'no_phi', group: 'prove', label: 'No patient information', description: 'Every delivered message in the action log is re-checked with the PHI guard and listed with its approver.' },
  { id: 'standby_declines', group: 'break', label: 'Standby declines', description: 'The plan’s top standby is pre-alerted (coordinator proposes, clinical lead approves) and answers not tonight from the phone link; the plan responds.' },
  { id: 'second_stroke_surge', group: 'break', label: 'Second stroke surge', description: 'A new stroke consult arrives at the hospital the surge forecast ranks first.' },
  { id: 'heartbeat_lost', group: 'break', label: 'Heartbeat lost', description: 'The desktop presence agent of a busy on-shift physician stops reporting.' },
  { id: 'status_flap', group: 'break', label: 'Status flap', description: 'One on-shift physician flips between Temporarily Unavailable and Available five times within a minute.' },
  { id: 'stroke_no_credentialed', group: 'break', label: 'Stroke with no credentialed physician', description: 'A stroke consult arrives at a hospital where no credentialed physician is available.' },
  { id: 'random_chaos', group: 'break', label: 'Random chaos', description: 'Twenty valid events drawn with a seeded generator from the break generators, pushed in one signed batch.' },
];

export const PROVE_IDS = ['late_event', 'duplicate_flood', 'deadlock_recovery', 'trap_proof', 'generalization', 'deterministic_forecast', 'no_phi'] as const;
export const BREAK_IDS = ['standby_declines', 'second_stroke_surge', 'heartbeat_lost', 'status_flap', 'stroke_no_credentialed', 'random_chaos'] as const;
export type StressActionId = (typeof PROVE_IDS)[number] | (typeof BREAK_IDS)[number];

// ------------------------------------------------------------------ totals (module state, since boot)

let handled = 0;
let errors = 0;
let seconds = 0;
let byAction: Record<string, number> = {};

export function stressTotals(): StressTotals {
  return { handled, errors, seconds: Math.round(seconds * 1000) / 1000, byAction: { ...byAction } };
}

/** Tests: forget the totals. */
export function resetStressTotals(): void {
  handled = 0;
  errors = 0;
  seconds = 0;
  byAction = {};
}

// ------------------------------------------------------------------ plumbing

/** Rate-limit key for the harness: its pushes never spend the operator's own budget. */
const STRESS_CLIENT = 'stress-harness';
const BASE = 'http://lookahead.internal';
const STRESS_ACTOR: ActorRef = { role: 'system', id: 'stress-harness' };
const VIDEO_STAGE = 'Video Consult In Progress';
const LATE_LAG_MS = 7 * 60_000;
const FLOOD_COPIES = 10;
const FLAP_PAIRS = 5;
const CHAOS_EVENTS = 20;

type Column = (typeof EVENT_COLUMNS)[number];
type Row = Readonly<Record<Column, string>>;

interface Outcome {
  readonly ok: boolean;
  readonly summary: string;
  readonly details: readonly string[];
  readonly metrics: Readonly<Record<string, number | string>>;
}

interface CommandReply {
  readonly ok: true;
  readonly seq: number;
  readonly emitted: readonly { readonly type: string; readonly seq: number; readonly offerId?: string; readonly standbyId?: string }[];
}

interface Run {
  readonly store: Store;
  readonly runId: string;
  readonly seed: number;
}

const floorSec = (ms: number) => Math.floor(ms / 1000) * 1000;

/** ISO-8601 with the explicit ET offset (event_stream.csv style, CLAUDE.md rule 4). */
export function etIso(ms: number): string {
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(etOffsetLabel(ms));
  if (m === null) return `${new Date(ms).toISOString().slice(0, 19)}+00:00`;
  const sign = m[1] === '-' ? -1 : 1;
  const hh = (m[2] ?? '0').padStart(2, '0');
  const mm = m[3] ?? '00';
  const offMin = sign * (Number(hh) * 60 + Number(mm));
  return `${new Date(ms + offMin * 60_000).toISOString().slice(0, 19)}${m[1]}${hh}:${mm}`;
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const rowLine = (r: Row) => EVENT_COLUMNS.map((c) => cell(r[c])).join(',');

function fresh(store: Store): { s: StoreSnapshot; view: ViewDTO } {
  const s = store.snapshot();
  return { s, view: computeView(s) };
}

/** New ids never collide with any id the dataset holds (counter from 1, skipping used ids). */
function idGen(s: StoreSnapshot) {
  const events = new Set(s.dataset.events.map((e) => e.eventId));
  const consults = new Set(s.dataset.events.flatMap((e) => (e.consultId === null ? [] : [e.consultId])));
  let e = 0;
  let c = 0;
  return {
    event(): string {
      let id = '';
      do id = `EVT-${900000 + ++e}`;
      while (events.has(id));
      events.add(id);
      return id;
    },
    consult(): string {
      let id = '';
      do id = `CON-${90000 + ++c}`;
      while (consults.has(id));
      consults.add(id);
      return id;
    },
  };
}
type Ids = ReturnType<typeof idGen>;

function makeRow(ids: Ids, x: { eventTimeMs: number; ingestedAtMs: number; consultId?: string | null; eventType: string; physicianId?: string | null; hospitalId?: string | null; description: string }): Row {
  return {
    event_id: ids.event(),
    event_time: etIso(x.eventTimeMs),
    ingested_at: etIso(x.ingestedAtMs),
    consult_id: x.consultId ?? '',
    event_type: x.eventType,
    physician_id: x.physicianId ?? '',
    hospital_id: x.hospitalId ?? '',
    description: x.description,
  };
}

/** Pushes event_stream.csv lines through the real v1 ingest route (signed when a secret is configured). */
async function postLines(lines: readonly string[]): Promise<IngestReportDTO> {
  const body = [EVENT_COLUMNS.join(','), ...lines].join('\n');
  const headers: Record<string, string> = { 'content-type': 'text/csv', 'x-real-ip': STRESS_CLIENT };
  const secret = ingestSecret();
  if (secret !== null) headers[SIGNATURE_HEADER] = signBody(secret, body);
  const res = await eventsPOST(new Request(`${BASE}/api/v1/events`, { method: 'POST', headers, body }));
  const json = (await res.json()) as IngestReportDTO & { code?: string; message?: string };
  if (res.status !== 200 && res.status !== 207) throw new StoreError(json.code ?? 'INGEST_FAILED', `event push refused (${res.status}): ${json.message ?? 'no message'}`);
  return json;
}

const postRows = (rows: readonly Row[]) => postLines(rows.map(rowLine));

/** Sends a command through the real POST /api/commands handler as the given role. */
async function postCommand(command: Record<string, unknown>, role: 'coordinator' | 'clinical_lead' | 'physician', actorId?: string, token?: string): Promise<CommandReply> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-lookahead-role': role, 'x-real-ip': STRESS_CLIENT };
  if (actorId !== undefined) headers['x-lookahead-actor-id'] = actorId;
  const cookies: string[] = [];
  if (role === 'clinical_lead') cookies.push(`${LEAD_COOKIE}=${encodeURIComponent(leadCookieValue())}`);
  if (role === 'coordinator' && !demoMode()) cookies.push(`${ROLE_COOKIE}=${encodeURIComponent(roleSessionValue('coordinator', Date.now() + 60_000))}`);
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  if (token !== undefined) headers['x-lookahead-offer-token'] = token;
  const res = await commandsPOST(new Request(`${BASE}/api/commands`, { method: 'POST', headers, body: JSON.stringify({ command }) }));
  const json = (await res.json()) as CommandReply | { ok: false; code: string; message: string };
  if (!res.ok || json.ok !== true) {
    const f = json as { code?: string; message?: string };
    throw new StoreError(f.code ?? 'COMMAND_FAILED', `${String(command.type)} as ${role}: ${f.message ?? `HTTP ${res.status}`}`);
  }
  return json;
}

/** Replaces denylisted tokens so the automated alert passes the PHI guard (brief "No patient information in any notification"). */
export function phiSafe(text: string): string {
  let out = text;
  for (const v of [...findPhiViolations(text)].reverse()) {
    const t = v.token.toLowerCase();
    const sub = v.label === 'consult id' || v.label === 'event id' ? '(id withheld)' : t === 'stroke' ? 'time-critical' : t.startsWith('neuro') ? 'specialty' : '[withheld]';
    out = out.slice(0, v.index) + sub + out.slice(v.index + v.token.length);
  }
  return findPhiViolations(out).length === 0 ? out : 'Stress test run recorded (text withheld by the PHI guard).';
}

async function recordAlert(run: Run, def: StressActionDef, summary: string): Promise<void> {
  const message = phiSafe(`Stress test: ${def.label}: ${summary}`);
  const r = await run.store.command({ type: 'sendInternalAlert', commandId: run.runId, actor: STRESS_ACTOR, message, physicianIds: [] });
  if (!r.ok) throw new StoreError(r.code, `internal alert not recorded: ${r.message}`);
}

// ------------------------------------------------------------------ view helpers

const deadlockOf = (view: ViewDTO, consultId: string): AttentionDTO | undefined => view.attention.find((a) => a.kind === 'ROUTING_DEADLOCK' && a.consultIds.includes(consultId));
const onShift = (p: PhysicianRowDTO) => p.shift !== '' && Number(p.minToEnd) > 0;
const nameOfPhysician = (view: ViewDTO, id: string) => view.physicians.find((p) => p.physicianId === id)?.name ?? id;
const hospitalNameOf = (s: StoreSnapshot, id: string) => s.dataset.hospitals.find((h) => h.hospitalId === id)?.hospitalName ?? id;
const credentialedAt = (s: StoreSnapshot, hospitalId: string) => s.dataset.credentials.filter((c) => c.credentialedHospitalIds.includes(hospitalId)).map((c) => c.physicianId);
const byId = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/**
 * A hospital with no credentialed routable physician now: first one the engine
 * already reports as deadlocked (brief "Routing Rules": no routable physician),
 * else one where no on-shift physician who is Available is credentialed.
 */
function noRoutableHospital(s: StoreSnapshot, view: ViewDTO): { hospitalId: string; basis: string } | null {
  const dead = view.attention.filter((a) => a.kind === 'ROUTING_DEADLOCK').flatMap((a) => a.hospitalIds);
  if (dead.length > 0) return { hospitalId: [...dead].sort()[0] ?? '', basis: 'the engine already reports a routing deadlock there' };
  const available = new Set(view.physicians.filter((p) => onShift(p) && p.derivedState === 'Available').map((p) => p.physicianId));
  const free = s.dataset.hospitals.map((h) => h.hospitalId).filter((h) => !credentialedAt(s, h).some((p) => available.has(p)));
  if (free.length === 0) return null;
  return { hospitalId: [...free].sort()[0] ?? '', basis: 'no on-shift physician credentialed there is Available' };
}

const consultReceived = (ids: Ids, hospitalId: string, type: 'Stroke' | 'General Neuro', tMs: number, ingestedMs: number, consultId = ids.consult()): Row =>
  makeRow(ids, { eventTimeMs: tMs, ingestedAtMs: ingestedMs, consultId, eventType: 'consult_received', hospitalId, description: `${type} consult request received` });

// ------------------------------------------------------------------ prove it

async function lateEvent(run: Run): Promise<Outcome> {
  const { s, view } = fresh(run.store);
  const now = view.clock.nowMs;
  const ingested = floorSec(now);
  const videos = view.consults.filter((c) => c.stage === VIDEO_STAGE && c.assigned !== null && c.enteredMs !== null).sort((a, b) => (a.enteredMs ?? 0) - (b.enteredMs ?? 0));
  if (videos.length === 0) throw new StoreError('PRECONDITION', `no open video consult at ${etHms(now)} ET to correct`);
  const pick = videos.find((c) => (c.enteredMs ?? now) <= ingested - LATE_LAG_MS - 60_000) ?? (videos[0] as ConsultRowDTO);
  const lag = Math.min(LATE_LAG_MS, Math.max(1_000, ingested - (pick.enteredMs ?? ingested) - 1_000));
  const eventTime = ingested - lag;
  const ids = idGen(s);
  const row = makeRow(ids, { eventTimeMs: eventTime, ingestedAtMs: ingested, consultId: pick.consultId, eventType: 'video_ended', physicianId: pick.assigned, hospitalId: pick.hospitalId, description: 'Video consult completed' });
  const report = await postRows([row]);
  const after = fresh(run.store).view.consults.find((c) => c.consultId === pick.consultId);
  const lagMin = Math.round(lag / 6_000) / 10;
  const corrected = after !== undefined && after.enteredMs === eventTime;
  const summary = after === undefined
    ? `The late video_ended for ${pick.consultId} closed the consult, so there is no stage timer to compare (accepted ${report.accepted}, late ${report.late}).`
    : `video_ended for ${pick.consultId} happened at ${etHms(eventTime)} but arrived at ${etHms(ingested)} (${lagMin} min late); replay ordered it by event time, so the stage moved from ${pick.stage} (${pick.minInStage ?? '-'} min) to ${after.stage} with its timer at ${after.minInStage ?? '-'} min, not 0.`;
  return {
    ok: report.accepted === 1 && corrected,
    summary,
    details: [
      `Event ${row.event_id}: event_time ${row.event_time}, ingested_at ${row.ingested_at}.`,
      `Ingest report: accepted ${report.accepted}, flagged late ${report.late}, duplicates ${report.duplicates}, rejected ${report.rejected.length}, signature ${report.signature}.`,
      `Before: stage ${pick.stage}, entered ${pick.enteredMs === null ? '-' : etHms(pick.enteredMs)}, ${pick.minInStage ?? '-'} min in stage.`,
      after === undefined ? 'After: consult no longer open.' : `After: stage ${after.stage}, entered ${after.enteredMs === null ? '-' : etHms(after.enteredMs)}, ${after.minInStage ?? '-'} min in stage.`,
    ],
    metrics: { lagMinutes: lagMin, timerBeforeMin: pick.minInStage ?? '-', timerAfterMin: after?.minInStage ?? '-', stageBefore: pick.stage, stageAfter: after?.stage ?? 'closed', late: report.late },
  };
}

async function duplicateFlood(run: Run): Promise<Outcome> {
  const { s, view } = fresh(run.store);
  const now = view.clock.nowMs;
  // Prefer a row of the Sevaro package itself (the first baseEventCount events); fall back to any known row.
  const known = s.dataset.events.filter((e) => e.ingestedAt <= now);
  const target = s.dataset.events.slice(0, s.baseEventCount).filter((e) => e.ingestedAt <= now).at(-1) ?? known.at(-1);
  if (target === undefined) throw new StoreError('PRECONDITION', 'no ingested event to duplicate');
  const line = csvRow(target);
  const before = s.dataset.events.length;
  const t0 = performance.now();
  let ignored = 0;
  let accepted = 0;
  for (let i = 0; i < FLOOD_COPIES; i++) {
    const r = await postLines([line]);
    ignored += r.duplicates;
    accepted += r.accepted;
  }
  const windowMs = Math.round(performance.now() - t0);
  const after = run.store.snapshot().dataset.events.length;
  return {
    ok: ignored === FLOOD_COPIES && accepted === 0 && after === before,
    summary: `${FLOOD_COPIES} exact copies of ${target.eventId} (${target.eventType}) were pushed in ${windowMs} ms: ignored: ${ignored}, accepted: ${accepted}; the dataset holds ${after} events before and after (dedupe on event_id, OQ-04).`,
    details: [`Row: ${line}`, `Window: ${windowMs} ms for ${FLOOD_COPIES} separate signed requests.`, `Events before ${before}, after ${after}.`],
    metrics: { ignored, accepted, windowMs, eventsBefore: before, eventsAfter: after },
  };
}

async function deadlockRecovery(run: Run): Promise<Outcome> {
  const { s, view } = fresh(run.store);
  const now = view.clock.nowMs;
  const h = noRoutableHospital(s, view);
  if (h === null) throw new StoreError('PRECONDITION', `every hospital has an Available credentialed on-shift physician at ${etHms(now)} ET`);
  const ids = idGen(s);
  const ingested = floorSec(now);
  const received = consultReceived(ids, h.hospitalId, 'Stroke', ingested - 2_000, ingested);
  const consultId = received.consult_id;
  await postRows([received]);
  const mid = fresh(run.store).view;
  const dead = deadlockOf(mid, consultId);
  const roster = new Set(mid.physicians.filter(onShift).map((p) => p.physicianId));
  const creds = credentialedAt(s, h.hospitalId);
  const assignee = creds.find((p) => roster.has(p)) ?? creds[0];
  if (assignee === undefined) throw new StoreError('PRECONDITION', `nobody is credentialed at ${h.hospitalId}; the deadlock cannot be resolved by assignment`);
  await postRows([makeRow(ids, { eventTimeMs: ingested - 1_000, ingestedAtMs: ingested, consultId, eventType: 'physician_assigned', physicianId: assignee, hospitalId: h.hospitalId, description: 'Consult assigned' })]);
  const end = fresh(run.store).view;
  const cleared = deadlockOf(end, consultId) === undefined;
  const row = end.consults.find((c) => c.consultId === consultId);
  const hn = hospitalNameOf(s, h.hospitalId);
  return {
    ok: dead !== undefined && cleared && row?.assigned === assignee,
    summary: `${dead !== undefined ? 'Deadlock raised' : 'No deadlock raised'} for a new unassigned stroke consult ${consultId} at ${hn} (${h.basis})${dead !== undefined ? `, ranked ${dead.rank} of ${mid.attention.length}` : ''}; after physician_assigned to ${nameOfPhysician(end, assignee)} (credentialed there) it ${cleared ? 'cleared' : 'did not clear'}.`,
    details: [
      dead === undefined ? 'Attention after receipt: no ROUTING_DEADLOCK item names the consult.' : `Attention after receipt: #${dead.rank} ${dead.headline}`,
      ...(dead?.why.slice(0, 3) ?? []),
      `After assignment: consult stage ${row?.stage ?? '-'}, assigned ${row?.assigned ?? 'nobody'}; deadlock items naming it: ${cleared ? 0 : 1}.`,
    ],
    metrics: { hospitalId: h.hospitalId, deadlockRank: dead?.rank ?? '-', cleared: cleared ? 'yes' : 'no', attentionBefore: view.attention.length, attentionAfter: end.attention.length },
  };
}

async function trapProof(run: Run): Promise<Outcome> {
  const { view } = fresh(run.store);
  const ro = view.recommendedOffer;
  const trap = ro?.trap ?? view.offerContext.trap;
  if (trap === null) {
    return { ok: true, summary: `No split-shift offer is recommended at ${etHms(view.clock.nowMs)} ET, so there is no joining physician whose routing could be trapped.`, details: [], metrics: { precondition: 'no recommended offer' } };
  }
  const name = trap.name ?? trap.physicianId;
  const firsts = (rows: typeof trap.before) => rows.filter((r) => r.firstPick);
  const b = firsts(trap.before);
  const a = firsts(trap.after);
  const outsideBefore = b.filter((r) => !r.inScope).length;
  const outsideAfter = a.filter((r) => !r.inScope).length;
  const list = (rows: typeof trap.before) => rows.map((r) => r.hospitalName).join(', ') || 'none';
  return {
    ok: true,
    summary: `Unscoped, ${name} would be first pick at ${b.length} of ${trap.before.length} credentialed hospitals (${outsideBefore} outside the gap); scoped to ${trap.scopeHospitalIds?.length ?? 0} hospital(s) and seeded with ${trap.seededConsultCount} consults, first pick at ${a.length} (${outsideAfter} outside). Computed by the engine's deterministic trap analysis of the routing rules (analyzeTrap); there is no Monte Carlo simulator in this repo.`,
    details: [
      `Unscoped first-pick hospitals: ${list(b)}.`,
      `Scoped and seeded first-pick hospitals: ${list(a)}.`,
      `Engine recommendation: ${trap.recommended.replace(/_/g, ' ')}; low-volume limit ${trap.lowVolumeLimit}.`,
      ...trap.trapWhy,
    ],
    metrics: { firstPickUnscoped: b.length, firstPickScoped: a.length, outsideScopeUnscoped: outsideBefore, outsideScopeScoped: outsideAfter, seededConsults: trap.seededConsultCount, model: 'analyzeTrap (deterministic)' },
  };
}

async function generalization(run: Run): Promise<Outcome> {
  const s = run.store.snapshot();
  const keyBefore = s.datasetMeta.key;
  const r = runGeneralization(s.datasetMeta.dir, s.dataset, s.clock.nowMs, run.seed);
  const after = run.store.snapshot();
  const untouched = after.datasetMeta.key === keyBefore && after.dataset === s.dataset;
  const same = r.checks.filter((c) => c.same).length;
  return {
    ok: r.allSame && untouched,
    summary: `A separate in-memory copy (${r.files} files, ${r.events} events; ids remapped, names replaced, dates +${r.dayShift} d, rows permuted) gave ${same} of ${r.checks.length} identical verdicts after mapping ids back (${r.checks.map((c) => `${c.name} ${c.same ? 'same' : 'DIFFERENT'}`).join(', ')}); ${r.originalIdsLeft} original ids left in the copy; live dataset ${untouched ? 'untouched' : 'CHANGED'}.`,
    details: r.checks.map((c) => `${c.name}: original [${c.original}] vs mutated [${c.mutated}]`),
    metrics: { verdictsSame: same, verdicts: r.checks.length, dayShift: r.dayShift, originalIdsLeft: r.originalIdsLeft, liveDatasetKey: after.datasetMeta.key },
  };
}

/** JSON with sorted keys and Maps/Sets expanded: the same value always serializes to the same bytes. */
export function stableJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (x instanceof Map) return [...x].map(([k, y]) => [k, norm(y)]);
    if (x instanceof Set) return [...x].map(norm);
    if (Array.isArray(x)) return x.map(norm);
    if (x !== null && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(norm(v));
}

async function deterministicForecast(run: Run): Promise<Outcome> {
  const s = run.store.snapshot();
  const now = s.clock.nowMs;
  const sha = (v: unknown) => createHash('sha256').update(stableJson(v)).digest('hex');
  const t0 = performance.now();
  // Run 1 and 2: replay and fit from scratch; run 3: the memoized fit the Command Center uses.
  const hashes = [0, 1].map(() => sha(forecast(s.dataset, replay(s.dataset, now), now)));
  const state = replay(s.dataset, now);
  hashes.push(sha(forecast(s.dataset, state, now, { fit: fitFor(s, state) })));
  const ms = Math.round(performance.now() - t0);
  const equal = hashes.every((h) => h === hashes[0]);
  return {
    ok: equal,
    summary: `The surge forecast at ${etHms(now)} ET was computed 3 times (twice from a fresh replay and fit, once from the memoized fit) in ${ms} ms; the SHA-256 hashes of its stable JSON are ${equal ? 'identical' : 'DIFFERENT'} (${hashes.map((h) => h.slice(0, 12)).join(', ')}).`,
    details: hashes.map((h, i) => `Run ${i + 1}: sha256 ${h}`),
    metrics: { runs: hashes.length, distinctHashes: new Set(hashes).size, ms, sha256: hashes[0] ?? '' },
  };
}

const APPROVAL_OF: Readonly<Record<string, { type: string; key: 'offerId' | 'standbyId' }>> = {
  offer_sent: { type: 'offer_approved', key: 'offerId' },
  standby_prealert_sent: { type: 'standby_approved', key: 'standbyId' },
  standby_activation_sent: { type: 'standby_activation_approved', key: 'standbyId' },
};

function approverOf(e: ActionEvent, log: ActionLog): string {
  if (e.type === 'internal_alert_sent') return e.payload.automated ? 'none required (automated internal alert, a low-risk step)' : `${e.actor.role}:${e.actor.id} (internal, no approval required)`;
  const rule = APPROVAL_OF[e.type];
  if (rule === undefined) return `${e.actor.role}:${e.actor.id}`;
  const id = (e.payload as Record<string, unknown>)[rule.key];
  const approval = [...log].reverse().find((x) => x.type === rule.type && x.seq < e.seq && (x.payload as Record<string, unknown>)[rule.key] === id);
  return approval === undefined ? 'NO APPROVAL FOUND' : `${approval.actor.role}:${approval.actor.id}`;
}

async function noPhi(run: Run): Promise<Outcome> {
  const s = run.store.snapshot();
  const delivered = s.log.filter((e) => typeof (e.payload as Record<string, unknown>).message === 'string');
  let pass = 0;
  let unapproved = 0;
  const details = delivered.map((e) => {
    const text = (e.payload as { message: string }).message;
    const v = findPhiViolations(text);
    if (v.length === 0) pass++;
    const approver = approverOf(e, s.log);
    if (approver === 'NO APPROVAL FOUND') unapproved++;
    return `${etHms(e.atMs)} ${e.type} (seq ${e.seq}): ${v.length === 0 ? 'PHI guard pass' : `PHI guard FAIL: ${v.map((x) => x.token).join(', ')}`}; approver ${approver}; text "${text}"`;
  });
  const fail = delivered.length - pass;
  return {
    ok: fail === 0 && unapproved === 0,
    summary: `${delivered.length} delivered message(s) in today's action log re-checked: ${pass} pass the PHI guard, ${fail} fail; ${delivered.length - unapproved} carry an approver or are automated internal alerts, ${unapproved} have no approval on record.`,
    details: details.length > 0 ? details : ['The action log holds no delivered message yet.'],
    metrics: { messages: delivered.length, pass, fail, unapproved },
  };
}

// ------------------------------------------------------------------ break it

async function standbyDeclines(run: Run): Promise<Outcome> {
  const { view } = fresh(run.store);
  const plan = view.standby.plan;
  const top = plan.selected[0];
  if (top === undefined) {
    return { ok: true, summary: `The standby plan selects nobody at ${etHms(view.clock.nowMs)} ET${plan.why[0] === undefined ? '' : ` (${plan.why[0]})`}, so there is no pre-alert to decline.`, details: [...plan.why], metrics: { precondition: 'no selection', residualEUMBefore: plan.totals.residualEUM } };
  }
  const steps: string[] = [];
  const mine = view.standby.standbys.filter((x) => x.physicianId === top.physicianId);
  let target = mine.find((x) => x.status === 'prealert_delivered' || x.status === 'prealert_sent');
  if (target === undefined) {
    let standbyId = mine.find((x) => x.status === 'proposed')?.standbyId;
    if (standbyId === undefined) {
      const r = await postCommand({ type: 'proposeStandby', physicianId: top.physicianId }, 'coordinator');
      standbyId = r.emitted.find((e) => e.standbyId !== undefined)?.standbyId;
      if (standbyId === undefined) throw new StoreError('INVALID_STATE', 'proposeStandby emitted no standby id');
      steps.push(`Coordinator proposed a standby pre-alert for ${top.name} (seq ${r.seq}).`);
    }
    const ap = await postCommand({ type: 'approveStandby', standbyId }, 'clinical_lead');
    steps.push(`Clinical lead approved it (seq ${ap.seq}); emitted ${ap.emitted.map((e) => e.type).join(', ')}.`);
    target = fresh(run.store).view.standby.standbys.find((x) => x.standbyId === standbyId);
    if (target === undefined) throw new StoreError('INVALID_STATE', 'approved standby not found in the view');
  } else steps.push(`A pre-alert for ${top.name} was already delivered (${target.status}).`);
  const rs = await postCommand({ type: 'respondStandby', standbyId: target.standbyId, response: 'not_tonight' }, 'physician', top.physicianId, standbyToken(target.standbyId));
  steps.push(`${top.name} answered "not tonight" from the phone link (seq ${rs.seq}).`);
  const after = fresh(run.store).view;
  const status = after.standby.standbys.find((x) => x.standbyId === target.standbyId)?.status ?? 'unknown';
  const next = after.standby.plan.selected[0];
  const planLine = next === undefined ? 'the plan now selects nobody' : next.physicianId === top.physicianId ? `the plan still lists ${next.name} first` : `the plan now selects ${next.name} first (${next.coveredHospitals.length} hospital(s), P(accept) ${next.pAccept})`;
  return {
    ok: status === 'declined',
    summary: `${top.name} declined the standby pre-alert (status ${status}); ${planLine}; residual expected unstaffed minutes ${plan.totals.residualEUM} -> ${after.standby.plan.totals.residualEUM}.`,
    details: [...steps, ...(next?.why.slice(0, 3) ?? after.standby.plan.why.slice(0, 3))],
    metrics: { standbyStatus: status, nextSelection: next?.name ?? 'none', residualEUMBefore: plan.totals.residualEUM, residualEUMAfter: after.standby.plan.totals.residualEUM },
  };
}

async function strokeAt(run: Run, hospitalId: string, basis: string): Promise<Outcome & { consultId: string }> {
  const { s, view } = fresh(run.store);
  const ids = idGen(s);
  const ingested = floorSec(view.clock.nowMs);
  const row = consultReceived(ids, hospitalId, 'Stroke', ingested, ingested);
  const report = await postRows([row]);
  const after = fresh(run.store).view;
  const dead = deadlockOf(after, row.consult_id);
  const fBefore = view.forecast.hospitals.find((x) => x.hospitalId === hospitalId);
  const fAfter = after.forecast.hospitals.find((x) => x.hospitalId === hospitalId);
  const hn = hospitalNameOf(s, hospitalId);
  return {
    consultId: row.consult_id,
    ok: report.accepted === 1,
    summary: `New stroke consult ${row.consult_id} at ${hn} (${basis}): ${dead === undefined ? 'a credentialed routable physician exists, no deadlock' : `no credentialed routable physician, deadlock ranked ${dead.rank} of ${after.attention.length}`}; observed consults in the last 60 min ${fBefore?.observedLast60 ?? '-'} -> ${fAfter?.observedLast60 ?? '-'}, spike now ${fAfter?.spikeNow === true ? 'yes' : 'no'}; attention items ${view.attention.length} -> ${after.attention.length}.`,
    details: [
      `Event ${row.event_id}: ${row.event_type} at ${row.event_time}.`,
      dead === undefined ? 'No ROUTING_DEADLOCK item names the consult.' : `#${dead.rank} ${dead.headline}`,
      ...(dead?.why.slice(0, 3) ?? []),
      fAfter === undefined ? '' : `Forecast: ${fAfter.driverSentence}`,
      after.recommendation === null ? 'No recommendation.' : `Recommendation: ${after.recommendation.headline}`,
    ].filter((x) => x !== ''),
    metrics: { hospitalId, deadlock: dead === undefined ? 'no' : 'yes', attentionBefore: view.attention.length, attentionAfter: after.attention.length, observedLast60After: fAfter?.observedLast60 ?? '-' },
  };
}

async function secondStrokeSurge(run: Run): Promise<Outcome> {
  const { view } = fresh(run.store);
  const top = [...view.forecast.hospitals].sort((a, b) => a.riskRank - b.riskRank)[0];
  if (top === undefined) throw new StoreError('PRECONDITION', 'the surge forecast lists no hospital');
  return strokeAt(run, top.hospitalId, `forecast risk rank ${top.riskRank}, multiplier ${Math.round(top.multiplier * 100) / 100}`);
}

async function strokeNoCredentialed(run: Run): Promise<Outcome> {
  const { s, view } = fresh(run.store);
  const h = noRoutableHospital(s, view);
  if (h === null) return { ok: true, summary: `Every hospital has an Available credentialed on-shift physician at ${etHms(view.clock.nowMs)} ET; no hospital qualifies, nothing injected.`, details: [], metrics: { precondition: 'no qualifying hospital' } };
  const r = await strokeAt(run, h.hospitalId, h.basis);
  const dead = deadlockOf(fresh(run.store).view, r.consultId);
  return { ...r, ok: r.ok && dead !== undefined };
}

function busyPhysician(view: ViewDTO): PhysicianRowDTO | undefined {
  const live = view.physicians.filter((p) => onShift(p) && p.agent === 'Online');
  return [...live].sort((a, b) => b.open - a.open || Number(a.derivedState === 'Available') - Number(b.derivedState === 'Available') || byId<PhysicianRowDTO>((p) => p.physicianId)(a, b))[0];
}

async function heartbeatLost(run: Run): Promise<Outcome> {
  const { s, view } = fresh(run.store);
  const p = busyPhysician(view);
  if (p === undefined) return { ok: true, summary: `No on-shift physician has a reporting presence agent at ${etHms(view.clock.nowMs)} ET; nothing to lose.`, details: [], metrics: { precondition: 'no online agent' } };
  const ids = idGen(s);
  const ingested = floorSec(view.clock.nowMs);
  const report = await postRows([makeRow(ids, { eventTimeMs: ingested, ingestedAtMs: ingested, eventType: 'agent_heartbeat_lost', physicianId: p.physicianId, description: 'Desktop presence agent stopped reporting' })]);
  const after = fresh(run.store).view;
  const q = after.physicians.find((x) => x.physicianId === p.physicianId);
  const naming = after.attention.filter((a) => a.physicianIds.includes(p.physicianId));
  return {
    ok: report.accepted === 1 && q?.agent === 'Offline',
    summary: `${p.name} (${p.open} open consult(s), ${p.derivedState}) lost the presence agent: agent ${p.agent} -> ${q?.agent ?? '-'}, derived state ${q?.derivedState ?? '-'}, flags ${q?.flags.map((f) => f.code).join(', ') || 'none'}; ${naming.length} attention item(s) now name them.`,
    details: [...naming.slice(0, 4).map((a) => `#${a.rank} ${a.headline}`), ...(q?.flags.map((f) => `${f.label}: ${f.detail}`) ?? [])],
    metrics: { physicianId: p.physicianId, agentAfter: q?.agent ?? '-', derivedAfter: q?.derivedState ?? '-', attentionNaming: naming.length },
  };
}

async function statusFlap(run: Run): Promise<Outcome> {
  const { s, view } = fresh(run.store);
  const pool = view.physicians.filter(onShift);
  const p = pool.find((x) => x.derivedState === 'Available') ?? pool[0];
  if (p === undefined) return { ok: true, summary: `No physician is on shift at ${etHms(view.clock.nowMs)} ET; nothing to flap.`, details: [], metrics: { precondition: 'nobody on shift' } };
  const ids = idGen(s);
  const ingested = floorSec(view.clock.nowMs);
  const n = FLAP_PAIRS * 2;
  const rows = Array.from({ length: n }, (_, i) =>
    makeRow(ids, { eventTimeMs: ingested - (n - 1 - i) * 5_000, ingestedAtMs: ingested, eventType: 'physician_status_changed', physicianId: p.physicianId, description: `Self-reported status: ${i % 2 === 0 ? 'Temporarily Unavailable' : 'Available'}` }),
  );
  const report = await postRows(rows);
  const after = fresh(run.store).view;
  const q = after.physicians.find((x) => x.physicianId === p.physicianId);
  const naming = after.attention.filter((a) => a.physicianIds.includes(p.physicianId));
  return {
    ok: report.accepted === n && q?.selfReported === 'Available',
    summary: `${n} status changes for ${p.name} within ${((n - 1) * 5_000) / 1000} s (Temporarily Unavailable and Available, ${FLAP_PAIRS} times each) were accepted in event-time order; the last report wins: self-reported ${q?.selfReported ?? '-'}, derived ${q?.derivedState ?? '-'}; ${naming.length} attention item(s) name them (before ${view.attention.filter((a) => a.physicianIds.includes(p.physicianId)).length}).`,
    details: [`Ingest report: accepted ${report.accepted}, duplicates ${report.duplicates}, rejected ${report.rejected.length}.`, ...naming.slice(0, 4).map((a) => `#${a.rank} ${a.headline}`)],
    metrics: { physicianId: p.physicianId, accepted: report.accepted, selfReportedAfter: q?.selfReported ?? '-', derivedAfter: q?.derivedState ?? '-' },
  };
}

type Generator = (rng: Rng, tMs: number, ingested: number) => { kind: string; row: Row | string } | null;

function chaosGenerators(s: StoreSnapshot, view: ViewDTO, ids: Ids): readonly Generator[] {
  const hospitals = s.dataset.hospitals.map((h) => h.hospitalId);
  const live = view.physicians.filter(onShift).map((p) => p.physicianId);
  const unassigned = view.consults.filter((c) => c.assigned === null && c.hospitalId !== '-');
  const known = s.dataset.events.filter((e) => e.ingestedAt <= view.clock.nowMs);
  const pick = <T>(rng: Rng, xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[rng.int(xs.length)]);
  return [
    (rng, t, ing) => {
      const h = pick(rng, hospitals);
      return h === undefined ? null : { kind: 'consult_received', row: consultReceived(ids, h, rng.next() < 0.5 ? 'Stroke' : 'General Neuro', t, ing) };
    },
    (rng, t, ing) => {
      const p = pick(rng, live);
      return p === undefined ? null : { kind: 'agent_heartbeat_lost', row: makeRow(ids, { eventTimeMs: t, ingestedAtMs: ing, eventType: 'agent_heartbeat_lost', physicianId: p, description: 'Desktop presence agent stopped reporting' }) };
    },
    (rng, t, ing) => {
      const p = pick(rng, live);
      const st = pick(rng, ['Available', 'Temporarily Unavailable', 'In Meeting'] as const);
      return p === undefined ? null : { kind: 'physician_status_changed', row: makeRow(ids, { eventTimeMs: t, ingestedAtMs: ing, eventType: 'physician_status_changed', physicianId: p, description: `Self-reported status: ${st}` }) };
    },
    (rng, t, ing) => {
      const p = pick(rng, live);
      return p === undefined ? null : { kind: 'camera_active', row: makeRow(ids, { eventTimeMs: t, ingestedAtMs: ing, eventType: 'camera_active', physicianId: p, description: 'Desktop agent: camera active; no Synapse video session' }) };
    },
    (rng, t, ing) => {
      const c = pick(rng, unassigned);
      return c === undefined ? null : { kind: 'routing_attempt_failed', row: makeRow(ids, { eventTimeMs: t, ingestedAtMs: ing, consultId: c.consultId, eventType: 'routing_attempt_failed', hospitalId: c.hospitalId, description: 'No available credentialed provider; retry scheduled' }) };
    },
    (rng) => {
      const e = pick(rng, known);
      return e === undefined ? null : { kind: 'duplicate', row: csvRow(e) };
    },
  ];
}

async function randomChaos(run: Run): Promise<Outcome> {
  const { s, view } = fresh(run.store);
  const ids = idGen(s);
  const rng = mulberry32(run.seed);
  const gens = chaosGenerators(s, view, ids);
  const ingested = floorSec(view.clock.nowMs);
  const lines: string[] = [];
  const kinds: Record<string, number> = {};
  for (let i = 0, guard = 0; lines.length < CHAOS_EVENTS && guard < CHAOS_EVENTS * 10; guard++, i++) {
    const g = gens[rng.int(gens.length)];
    const out = g?.(rng, ingested - (CHAOS_EVENTS - lines.length) * 1_000, ingested) ?? null;
    if (out === null) continue;
    lines.push(typeof out.row === 'string' ? out.row : rowLine(out.row));
    kinds[out.kind] = (kinds[out.kind] ?? 0) + 1;
  }
  const report = await postLines(lines);
  const after = fresh(run.store).view;
  const dead = (v: ViewDTO) => v.attention.filter((a) => a.kind === 'ROUTING_DEADLOCK').length;
  const mix = Object.entries(kinds).sort().map(([k, n]) => `${k} ${n}`).join(', ');
  return {
    ok: report.rejected.length === 0 && report.accepted + report.duplicates === lines.length,
    summary: `${lines.length} seeded events (seed ${run.seed}: ${mix}) in one batch: accepted ${report.accepted}, ignored as duplicates ${report.duplicates}, rejected ${report.rejected.length}; view recomputed with attention items ${view.attention.length} -> ${after.attention.length} and deadlocks ${dead(view)} -> ${dead(after)}.`,
    details: [...report.rejected.map((r) => `Rejected row ${r.row}: ${r.reason}`), ...after.attention.slice(0, 5).map((a) => `#${a.rank} ${a.headline}`)],
    metrics: { seed: run.seed, events: lines.length, accepted: report.accepted, duplicates: report.duplicates, rejected: report.rejected.length, attentionAfter: after.attention.length },
  };
}

const RUNNERS: Readonly<Record<StressActionId, (run: Run) => Promise<Outcome>>> = {
  late_event: lateEvent,
  duplicate_flood: duplicateFlood,
  deadlock_recovery: deadlockRecovery,
  trap_proof: trapProof,
  generalization,
  deterministic_forecast: deterministicForecast,
  no_phi: noPhi,
  standby_declines: standbyDeclines,
  second_stroke_surge: secondStrokeSurge,
  heartbeat_lost: heartbeatLost,
  status_flap: statusFlap,
  stroke_no_credentialed: strokeNoCredentialed,
  random_chaos: randomChaos,
};

// ------------------------------------------------------------------ entry

/** Runs are serialized so two clicks never interleave their events. */
let chain: Promise<unknown> = Promise.resolve();

export function runStress(action: unknown, seed?: unknown): Promise<{ result: StressResult; totals: StressTotals }> {
  const def = STRESS_ACTIONS.find((a) => a.id === action);
  if (def === undefined) throw new StoreError('BAD_REQUEST', `unknown stress action ${JSON.stringify(action)} (one of ${STRESS_ACTIONS.map((a) => a.id).join(', ')})`);
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isInteger(seed))) throw new StoreError('BAD_REQUEST', 'seed must be an integer');
  const next = chain.then(() => execute(def, seed as number | undefined));
  chain = next.catch(() => undefined);
  return next;
}

async function execute(def: StressActionDef, seed: number | undefined): Promise<{ result: StressResult; totals: StressTotals }> {
  const id = `stress-${randomUUID()}`;
  const startedAtMs = Date.now();
  const t0 = performance.now();
  let outcome: Outcome | null = null;
  let error: string | null = null;
  try {
    const store = await getReadyStore();
    const run: Run = { store, runId: id, seed: (seed ?? seedFromString(id)) >>> 0 };
    outcome = await RUNNERS[def.id as StressActionId](run);
    await recordAlert(run, def, outcome.ok ? outcome.summary : `did not hold: ${outcome.summary}`);
  } catch (e) {
    error = e instanceof StoreError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    try {
      const store = await getReadyStore();
      await recordAlert({ store, runId: id, seed: 0 }, def, `failed: ${error}`);
    } catch {
      // The failure is already reported in the result; a second failure to record it changes nothing.
    }
  }
  const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
  const ok = error === null && outcome !== null && outcome.ok;
  handled++;
  if (!ok) errors++;
  seconds += latencyMs / 1000;
  byAction[def.id] = (byAction[def.id] ?? 0) + 1;
  const result: StressResult = {
    id,
    action: def.id,
    group: def.group,
    ok,
    latencyMs,
    startedAtMs,
    summary: outcome?.summary ?? `${def.label} failed: ${error ?? 'unknown error'}`,
    details: outcome?.details ?? [],
    metrics: outcome?.metrics ?? {},
    error: error ?? (outcome !== null && !outcome.ok ? 'the expected outcome did not hold (see summary)' : null),
  };
  return { result, totals: stressTotals() };
}
