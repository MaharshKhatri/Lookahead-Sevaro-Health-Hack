import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  EVENT_COLUMNS,
  appendEventText,
  applyCommand,
  etDateOf,
  etWallClockToEpoch,
  headSeq,
  snapshotAsOfMs,
  type ActionLog,
  type ActorRef,
  type Command,
  type CommandResult,
  type Dataset,
  type RawEvent,
} from '@lookahead/engine';
import { MAPPING_FILE, ingestDir } from '@lookahead/engine/loaders';
import type { ClockMode, ClockSpeed } from '@/lib/dto';
import { archiveLog } from './archive';
import { actContext } from './forecast';
import { Mutex } from './mutex';
import { dataDir, liveDir } from './paths';
import { backendFromEnv, type InjectedRow, type Repos, type StoreBackend } from './repo';

/**
 * The single in-memory store behind every route (Sessions 6-7). It holds the
 * active Sevaro dataset (data/raw or an activated upload) plus rows injected
 * during the demo, our action log, and the simulated clock. All engine calls
 * are pure; this module owns the mutable state. Every mutation runs under one
 * mutex, persists through the repos (file or DynamoDB, D-75/D-76) and bumps
 * `version` so SSE clients refetch.
 */

export interface ClockState {
  readonly nowMs: number;
  readonly mode: ClockMode;
  readonly speed: ClockSpeed;
}

export interface DatasetMeta {
  /** Content hash of the package (stable across restarts and servers); scopes the repos. */
  readonly key: string;
  readonly source: 'raw' | 'upload';
  readonly dir: string;
  readonly label: string;
  readonly snapshotLabel: string | null;
  readonly eventCount: number;
}

export interface StoreSnapshot {
  readonly bootId: string;
  readonly version: number;
  /** Bumped whenever Sevaro events or the active dataset change (integrity caches key on it). */
  readonly datasetVersion: number;
  readonly dataset: Dataset;
  readonly baseEventCount: number;
  readonly log: ActionLog;
  readonly clock: ClockState;
  readonly snapshotMs: number;
  readonly datasetMeta: DatasetMeta;
  readonly previousMeta: DatasetMeta | null;
  readonly storeKind: string;
}

export interface StoreEvent {
  readonly type: 'clock' | 'events' | 'actions' | 'reset' | 'dataset';
  readonly version: number;
  readonly nowMs: number;
}

export interface InjectResult {
  readonly nowMs: number;
  readonly header: 'present' | 'absent';
  readonly accepted: readonly { readonly line: number; readonly eventId: string; readonly eventType: string; readonly eventTimeMs: number; readonly ingestedAtMs: number; readonly ingestedAtDefaulted: boolean }[];
  readonly duplicates: readonly { readonly line: number; readonly eventId: string; readonly reason: string }[];
  readonly rejected: readonly { readonly line: number; readonly reason: string }[];
  readonly warnings: readonly string[];
  /** When accepted rows are dated after the sim clock: the instant they all become known (knowledge time, D-20). */
  readonly knownFromMs: number | null;
}

export type ClockAction =
  | { readonly action: 'set'; readonly nowMs?: number; readonly speed?: ClockSpeed }
  | { readonly action: 'play'; readonly speed?: ClockSpeed }
  | { readonly action: 'pause' }
  | { readonly action: 'advance'; readonly minutes?: number; readonly seconds?: number }
  | { readonly action: 'jump'; readonly to: string };

export const SPEEDS: readonly ClockSpeed[] = [1, 10, 60];
/** Real milliseconds between clock steps while playing; each step advances speed x this in sim time. */
export const PLAY_STEP_MS = 1_000;
/** Storage conflicts (another writer took the seq) are re-applied against the fresh log up to this many times. */
export const MAX_CONFLICT_RETRIES = 3;
export const ACTIVE_FILE = 'active-dataset.json';

const SIM_CLOCK: ActorRef = { role: 'system', id: 'sim-clock' };

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface LoadedDataset {
  readonly dataset: Dataset;
  readonly meta: DatasetMeta;
}

export interface StoreOptions {
  readonly playStepMs?: number;
  readonly backend?: StoreBackend;
}

export class Store {
  readonly bootId = randomUUID();
  readonly ready: Promise<void>;
  readonly backend: StoreBackend;
  readonly bootWarnings: string[] = [];
  readonly playStepMs: number;
  /** Storage conflicts resolved by re-applying against the fresh log (health/diagnostics). */
  conflictsResolved = 0;
  private current!: LoadedDataset;
  private previous: LoadedDataset | null = null;
  private dataset!: Dataset;
  private injected: InjectedRow[] = [];
  private log: ActionLog = [];
  private clock: ClockState = { nowMs: 0, mode: 'paused', speed: 1 };
  private repos!: Repos;
  private version = 1;
  private datasetVersion = 0;
  private readonly mutex = new Mutex();
  private readonly listeners = new Set<(e: StoreEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly dirs: { readonly data: string; readonly live: string },
    opts: StoreOptions = {},
  ) {
    this.playStepMs = opts.playStepMs ?? PLAY_STEP_MS;
    this.backend = opts.backend ?? backendFromEnv(dirs.live);
    this.ready = this.mutex.run(() => this.boot());
  }

  // ------------------------------------------------------------------ reads

  snapshot(): StoreSnapshot {
    return {
      bootId: this.bootId,
      version: this.version,
      datasetVersion: this.datasetVersion,
      dataset: this.dataset,
      baseEventCount: this.current.dataset.events.length,
      log: this.log,
      clock: this.clock,
      snapshotMs: defaultNow(this.current.dataset),
      datasetMeta: this.current.meta,
      previousMeta: this.previous?.meta ?? null,
      storeKind: this.backend.describe(),
    };
  }

  subscribe(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------ mutations

  /**
   * POST /api/commands: the engine's pure command processor at the sim clock.
   * If the repo reports that another writer already took the seq, reload the
   * log and re-apply: the engine then answers from the fresh state (CONFLICT
   * for a stale expectedSeq, NO_LONGER_AVAILABLE / INVALID_STATE for an offer
   * someone else answered, or a clean success).
   */
  command(command: Command): Promise<CommandResult & { readonly seq: number }> {
    return this.mutex.run(async () => {
      for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
        // Standby commands plan on the surge forecast; the fit memoized for this dataset version and minute keeps the engine pure and the command cheap (Phase 7).
        const r = applyCommand(actContext(this.dataset, this.bootId, this.datasetVersion, this.clock.nowMs), this.log, command, this.clock.nowMs);
        if (!r.ok || r.replayed || r.emitted.length === 0) return { ...r, seq: headSeq(this.log) };
        const w = await this.repos.actions.append(headSeq(this.log), r.emitted);
        if (w.ok) {
          this.log = r.log;
          this.bump('actions');
          return { ...r, seq: headSeq(this.log) };
        }
        this.conflictsResolved++;
        this.log = Object.freeze(await this.repos.actions.load());
        this.bump('actions');
      }
      return { ok: false, code: 'CONFLICT', message: `storage conflict persisted after ${MAX_CONFLICT_RETRIES} attempts`, seq: headSeq(this.log) };
    });
  }

  /** POST /api/events: Sevaro rows appended at the sim clock (live test, brief "What Teams Must Demonstrate" #8). */
  inject(text: string): Promise<InjectResult> {
    return this.mutex.run(async () => {
      const nowMs = this.clock.nowMs;
      let r = appendEventText(this.dataset, text, { nowMs });
      if (r.accepted.length > 0) {
        let rows = this.rowsFor(r.accepted, nowMs);
        let w = await this.repos.events.append(rows);
        if (!w.ok) {
          // Another server injected first: rebuild from the stored rows and try once more.
          this.conflictsResolved++;
          this.injected = await this.repos.events.load();
          this.dataset = applyRows(this.current.dataset, this.injected, []);
          r = appendEventText(this.dataset, text, { nowMs });
          rows = this.rowsFor(r.accepted, nowMs);
          w = rows.length === 0 ? { ok: true } : await this.repos.events.append(rows);
          if (!w.ok) throw new StoreError('CONFLICT', w.detail);
        }
        this.injected = [...this.injected, ...rows];
        this.dataset = r.dataset;
        this.datasetVersion++;
        this.bump('events');
      }
      const defaulted = new Set(r.ingestedAtDefaulted.map((d) => d.eventId));
      const knownFrom = Math.max(...r.accepted.map((e) => Math.max(e.ingestedAt, e.eventTime)), Number.NEGATIVE_INFINITY);
      return {
        nowMs,
        header: r.header,
        accepted: r.accepted.map((e) => ({ line: e.line, eventId: e.eventId, eventType: e.eventType, eventTimeMs: e.eventTime, ingestedAtMs: e.ingestedAt, ingestedAtDefaulted: defaulted.has(e.eventId) })),
        duplicates: r.duplicates,
        rejected: r.rejected,
        warnings: r.warnings,
        knownFromMs: knownFrom > nowMs ? knownFrom : null,
      };
    });
  }

  /** POST /api/clock. Every move runs a system `tick` so derived expiries are materialized (OQ-36). */
  moveClock(a: ClockAction): Promise<ClockState> {
    return this.mutex.run(async () => {
      const c = this.clock;
      switch (a.action) {
        case 'pause':
          await this.setClock({ ...c, mode: 'paused' });
          break;
        case 'play':
          await this.setClock({ ...c, mode: 'playing', speed: a.speed ?? c.speed });
          break;
        case 'set':
          await this.setClock({ ...c, nowMs: a.nowMs ?? c.nowMs, speed: a.speed ?? c.speed });
          break;
        case 'advance':
          await this.setClock({ ...c, nowMs: c.nowMs + (a.minutes ?? 0) * 60_000 + (a.seconds ?? 0) * 1_000 });
          break;
        case 'jump':
          await this.setClock({ ...c, nowMs: this.etToday(a.to) });
          break;
      }
      return this.clock;
    });
  }

  /** POST /api/demo/reset: archives the log (if configured), clears injected rows and actions, clock back to the dataset's reference instant, paused. */
  reset(): Promise<ClockState> {
    return this.mutex.run(async () => {
      await this.install(this.current, true);
      this.bump('reset');
      return this.clock;
    });
  }

  /** Dataset swap (Session 7): activate an ingested upload directory; the previous dataset is kept for one-click revert. */
  activate(dir: string, label: string): Promise<DatasetMeta> {
    return this.mutex.run(async () => {
      const next = loadDir(dir, 'upload', label);
      const prev = this.current;
      await this.install(next, true);
      this.previous = prev;
      this.writeActive();
      this.bump('dataset');
      return next.meta;
    });
  }

  revert(): Promise<DatasetMeta> {
    return this.mutex.run(async () => {
      const prev = this.previous;
      if (prev === null) throw new StoreError('INVALID_STATE', 'there is no previous dataset to revert to');
      const cur = this.current;
      await this.install(prev, true);
      this.previous = cur;
      this.writeActive();
      this.bump('dataset');
      return prev.meta;
    });
  }

  /** Stops the play loop (tests, shutdown). */
  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ internals

  private async boot(): Promise<void> {
    let current = loadDir(this.dirs.data, 'raw', 'data/raw (reference package)');
    const pointer = readActive(this.dirs.live);
    if (pointer?.active.source === 'upload') {
      try {
        current = loadDir(pointer.active.dir, 'upload', pointer.active.label);
      } catch (e) {
        this.bootWarnings.push(`active upload ${pointer.active.dir} not loaded (${e instanceof Error ? e.message : String(e)}); using data/raw`);
      }
    }
    if (pointer?.previous !== null && pointer?.previous !== undefined) {
      try {
        this.previous = loadDir(pointer.previous.dir, pointer.previous.source, pointer.previous.label);
      } catch {
        this.previous = null;
      }
    }
    await this.install(current, false);
  }

  /** Makes `next` the active dataset. fresh = start a new run (archive + clear); otherwise restore its stored rows and actions. */
  private async install(next: LoadedDataset, fresh: boolean): Promise<void> {
    if (fresh && this.repos !== undefined) await archiveLog(this.current.meta.key, this.log);
    this.current = next;
    this.repos = this.backend.factory(next.meta.key);
    this.datasetVersion++;
    if (fresh) {
      await this.repos.actions.clear();
      await this.repos.events.clear();
      this.injected = [];
      this.log = [];
      this.dataset = next.dataset;
    } else {
      this.injected = await this.repos.events.load();
      this.dataset = applyRows(next.dataset, this.injected, this.bootWarnings);
      const actions = await this.repos.actions.load();
      if (actions.every((a, i) => a.seq === i + 1)) this.log = Object.freeze(actions.map((a) => Object.freeze(a)));
      else this.bootWarnings.push('stored action log: seq is not contiguous; not restored');
    }
    const lastAction = this.log.at(-1)?.atMs ?? 0;
    const lastInjected = Math.max(0, ...this.injected.map((r) => r.atMs));
    this.setClockRaw({ nowMs: Math.max(defaultNow(next.dataset), lastAction, lastInjected), mode: 'paused', speed: 1 });
  }

  private rowsFor(accepted: readonly RawEvent[], atMs: number): InjectedRow[] {
    const base = this.injected.at(-1)?.seq ?? 0;
    return accepted.map((e, i) => ({ seq: base + i + 1, atMs, row: csvRow(e) }));
  }

  private bump(type: StoreEvent['type']): void {
    this.version++;
    const e: StoreEvent = { type, version: this.version, nowMs: this.clock.nowMs };
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // A broken SSE client must not break the store.
      }
    }
  }

  private setClockRaw(next: ClockState): void {
    this.clock = { ...next, nowMs: clampClock(next.nowMs, this.current.dataset) };
    this.syncTimer();
  }

  private async setClock(next: ClockState, announce = true): Promise<void> {
    if (!SPEEDS.includes(next.speed)) throw new StoreError('BAD_REQUEST', `speed must be one of ${SPEEDS.join(', ')}`);
    this.setClockRaw(next);
    await this.tick();
    if (announce) this.bump('clock');
  }

  /** Materializes expiries at the sim clock; a clock behind the last action is a view-only rewind (no tick). */
  private async tick(): Promise<void> {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
      const head = this.log.at(-1);
      if (head !== undefined && this.clock.nowMs < head.atMs) return;
      const r = applyCommand(actContext(this.dataset, this.bootId, this.datasetVersion, this.clock.nowMs), this.log, { type: 'tick', commandId: `tick@${this.clock.nowMs}`, actor: SIM_CLOCK }, this.clock.nowMs);
      if (!r.ok || r.replayed || r.emitted.length === 0) return;
      const w = await this.repos.actions.append(headSeq(this.log), r.emitted);
      if (w.ok) {
        this.log = r.log;
        return;
      }
      this.conflictsResolved++;
      this.log = Object.freeze(await this.repos.actions.load());
    }
  }

  private syncTimer(): void {
    if (this.clock.mode === 'playing' && this.timer === null) {
      this.timer = setInterval(() => {
        void this.mutex
          .run(async () => {
            if (this.clock.mode !== 'playing') return;
            await this.setClock({ ...this.clock, nowMs: this.clock.nowMs + this.playStepMs * this.clock.speed });
          })
          .catch((e: unknown) => console.warn('[lookahead] play step failed:', e));
      }, this.playStepMs);
      this.timer.unref?.();
    } else if (this.clock.mode === 'paused' && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private etToday(hhmm: string): number {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm.trim());
    if (m === null) throw new StoreError('BAD_REQUEST', `jump target "${hhmm}" is not HH:mm[:ss] (ET)`);
    const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
    return etWallClockToEpoch(etDateOf(defaultNow(this.current.dataset)), secs);
  }

  private writeActive(): void {
    const ref = (d: LoadedDataset) => ({ dir: d.meta.dir, source: d.meta.source, label: d.meta.label });
    mkdirSync(this.dirs.live, { recursive: true });
    writeFileSync(join(this.dirs.live, ACTIVE_FILE), JSON.stringify({ active: ref(this.current), previous: this.previous === null ? null : ref(this.previous) }, null, 2));
  }
}

// ------------------------------------------------------------------ dataset helpers

/** "Now" for a dataset: its reference snapshot instant (OQ-13), else its last ingested event. */
export function defaultNow(d: Dataset): number {
  return snapshotAsOfMs(d) ?? Math.max(...d.events.map((e) => e.ingestedAt));
}

/** Content hash of a package directory (*.csv + mapping.json): the same data gives the same key on every server. */
export function datasetKeyOf(dir: string): string {
  const h = createHash('sha256');
  for (const name of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv') || n === MAPPING_FILE).sort()) {
    h.update(name);
    h.update('\0');
    h.update(readFileSync(join(dir, name)));
    h.update('\0');
  }
  return `ds-${h.digest('hex').slice(0, 16)}`;
}

function loadDir(dir: string, source: DatasetMeta['source'], label: string): LoadedDataset {
  const r = ingestDir(dir);
  if (r.dataset === null) {
    const why = [...r.report.errors, ...r.report.missingFiles.map((k) => `missing ${k} file`), ...r.report.files.flatMap((f) => f.missing.map((m) => `${f.source}: missing column ${m.column}`))];
    throw new StoreError('BAD_DATASET', `${basename(dir)} does not ingest: ${why.slice(0, 5).join('; ') || 'row errors (see the ingest report)'}`);
  }
  const d = r.dataset;
  return { dataset: d, meta: { key: datasetKeyOf(dir), source, dir, label, snapshotLabel: d.snapshot?.label ?? null, eventCount: d.events.length } };
}

function applyRows(base: Dataset, rows: readonly InjectedRow[], warnings: string[]): Dataset {
  let d = base;
  for (const rec of rows) {
    const r = appendEventText(d, `${EVENT_COLUMNS.join(',')}\n${rec.row}`, { nowMs: rec.atMs });
    if (r.accepted.length === 1) d = r.dataset;
    else warnings.push(`stored row not re-applied (${[...r.rejected.map((x) => x.reason), ...r.duplicates.map((x) => x.reason)].join('; ')}): ${rec.row}`);
  }
  return d;
}

interface ActivePointer {
  readonly active: { readonly dir: string; readonly source: DatasetMeta['source']; readonly label: string };
  readonly previous: { readonly dir: string; readonly source: DatasetMeta['source']; readonly label: string } | null;
}

function readActive(live: string): ActivePointer | null {
  const path = join(live, ACTIVE_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ActivePointer;
  } catch {
    return null;
  }
}

/** The clock stays within the scenario: from the first event to 24 h after the reference instant. */
function clampClock(nowMs: number, base: Dataset): number {
  if (!Number.isFinite(nowMs)) throw new StoreError('BAD_REQUEST', 'clock time must be a finite epoch-ms number');
  const first = Math.min(...base.events.map((e) => e.eventTime));
  return Math.round(Math.min(Math.max(nowMs, first), defaultNow(base) + 24 * 3_600_000));
}

const csvCell = (v: string | null) => {
  const s = v ?? '';
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** An accepted event as an event_stream.csv line (columns in file order). */
export function csvRow(e: RawEvent): string {
  return [e.eventId, e.eventTimeRaw, e.ingestedAtRaw, e.consultId, e.eventType, e.physicianId, e.hospitalId, e.description].map(csvCell).join(',');
}

// ------------------------------------------------------------------ singleton

const holder = globalThis as unknown as { __lookaheadStore?: Store };

/** One store per server process (route bundles and dev reloads share it via globalThis). */
export function getStore(): Store {
  holder.__lookaheadStore ??= new Store({ data: dataDir(), live: liveDir() });
  return holder.__lookaheadStore;
}

/** The store once booted (dataset loaded, stored rows and actions restored). */
export async function getReadyStore(): Promise<Store> {
  const s = getStore();
  await s.ready;
  return s;
}

/** Tests only: drop the singleton so the next getStore() boots from storage again. */
export function disposeStore(): void {
  holder.__lookaheadStore?.dispose();
  delete holder.__lookaheadStore;
}
