import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  EVENT_COLUMNS,
  appendEventText,
  applyCommand,
  etDateOf,
  etWallClockToEpoch,
  headSeq,
  snapshotAsOfMs,
  type ActionEvent,
  type ActionLog,
  type ActorRef,
  type Command,
  type CommandResult,
  type Dataset,
  type RawEvent,
} from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import type { ClockMode, ClockSpeed } from '@/lib/dto';
import { Mutex } from './mutex';
import { dataDir, liveDir } from './paths';
import { ACTIONS_FILE, EVENTS_FILE, appendJsonl, clearLive, readJsonl } from './persist';

/**
 * The single in-memory store behind every route (Session 6). It holds the
 * Sevaro dataset (data/raw plus rows injected during the demo), our action
 * log, and the simulated clock. All engine calls are pure; this module is the
 * only place that owns mutable state, and every mutation runs under one
 * mutex and bumps `version` so SSE clients refetch.
 */

export interface ClockState {
  readonly nowMs: number;
  readonly mode: ClockMode;
  readonly speed: ClockSpeed;
}

export interface StoreSnapshot {
  readonly bootId: string;
  readonly version: number;
  /** Bumped only when Sevaro events change (integrity caches key on it). */
  readonly datasetVersion: number;
  readonly dataset: Dataset;
  readonly baseEventCount: number;
  readonly log: ActionLog;
  readonly clock: ClockState;
  readonly snapshotMs: number;
}

export interface StoreEvent {
  readonly type: 'clock' | 'events' | 'actions' | 'reset';
  readonly version: number;
  readonly nowMs: number;
}

/** One persisted Sevaro row: the sim time it was injected at and its event_stream.csv line. */
interface InjectedRecord {
  readonly atMs: number;
  readonly row: string;
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

const SIM_CLOCK: ActorRef = { role: 'system', id: 'sim-clock' };

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Store {
  readonly bootId = randomUUID();
  readonly baseDataset: Dataset;
  readonly snapshotMs: number;
  private dataset: Dataset;
  private log: ActionLog = [];
  private clock: ClockState;
  private version = 1;
  private datasetVersion = 1;
  private readonly mutex = new Mutex();
  private readonly listeners = new Set<(e: StoreEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly bootWarnings: string[] = [];

  constructor(
    readonly dirs: { readonly data: string; readonly live: string },
    readonly playStepMs: number = PLAY_STEP_MS,
  ) {
    this.baseDataset = loadDataset(dirs.data);
    const snap = snapshotAsOfMs(this.baseDataset);
    // No snapshot in the package: "now" is the last ingested event (OQ-13).
    this.snapshotMs = snap ?? Math.max(...this.baseDataset.events.map((e) => e.ingestedAt));
    this.dataset = this.baseDataset;
    this.clock = { nowMs: this.snapshotMs, mode: 'paused', speed: 1 };
    this.replayLive();
  }

  // ------------------------------------------------------------------ reads

  snapshot(): StoreSnapshot {
    return {
      bootId: this.bootId,
      version: this.version,
      datasetVersion: this.datasetVersion,
      dataset: this.dataset,
      baseEventCount: this.baseDataset.events.length,
      log: this.log,
      clock: this.clock,
      snapshotMs: this.snapshotMs,
    };
  }

  subscribe(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------ mutations

  /** POST /api/commands: the engine's pure command processor at the sim clock. */
  command(command: Command): Promise<CommandResult & { readonly seq: number }> {
    return this.mutex.run(() => {
      const r = applyCommand({ dataset: this.dataset }, this.log, command, this.clock.nowMs);
      if (r.ok && !r.replayed && r.emitted.length > 0) this.commitActions(r.log, r.emitted);
      return { ...r, seq: headSeq(this.log) };
    });
  }

  /** POST /api/events: Sevaro rows appended at the sim clock (live test, brief "What Teams Must Demonstrate" #8). */
  inject(text: string): Promise<InjectResult> {
    return this.mutex.run(() => {
      const nowMs = this.clock.nowMs;
      const r = appendEventText(this.dataset, text, { nowMs });
      if (r.accepted.length > 0) {
        this.dataset = r.dataset;
        appendJsonl(this.dirs.live, EVENTS_FILE, r.accepted.map((e): InjectedRecord => ({ atMs: nowMs, row: csvRow(e) })));
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
    return this.mutex.run(() => {
      const c = this.clock;
      switch (a.action) {
        case 'pause':
          this.setClock({ ...c, mode: 'paused' });
          break;
        case 'play':
          this.setClock({ ...c, mode: 'playing', speed: a.speed ?? c.speed });
          break;
        case 'set':
          this.setClock({ ...c, nowMs: a.nowMs ?? c.nowMs, speed: a.speed ?? c.speed });
          break;
        case 'advance':
          this.setClock({ ...c, nowMs: c.nowMs + (a.minutes ?? 0) * 60_000 + (a.seconds ?? 0) * 1_000 });
          break;
        case 'jump':
          this.setClock({ ...c, nowMs: this.etToday(a.to) });
          break;
      }
      return this.clock;
    });
  }

  /** POST /api/demo/reset: clears data/live and returns to the reference instant, paused. */
  reset(): Promise<ClockState> {
    return this.mutex.run(() => {
      clearLive(this.dirs.live);
      this.dataset = this.baseDataset;
      this.log = [];
      this.datasetVersion++;
      this.setClock({ nowMs: this.snapshotMs, mode: 'paused', speed: 1 }, false);
      this.bump('reset');
      return this.clock;
    });
  }

  /** Stops the play loop (tests, shutdown). */
  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ internals

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

  private commitActions(log: ActionLog, emitted: readonly ActionEvent[]): void {
    appendJsonl(this.dirs.live, ACTIONS_FILE, emitted);
    this.log = log;
    this.bump('actions');
  }

  private setClock(next: ClockState, announce = true): void {
    const nowMs = clampClock(next.nowMs, this.baseDataset, this.snapshotMs);
    if (!SPEEDS.includes(next.speed)) throw new StoreError('BAD_REQUEST', `speed must be one of ${SPEEDS.join(', ')}`);
    this.clock = { ...next, nowMs };
    this.tick();
    this.syncTimer();
    if (announce) this.bump('clock');
  }

  /** Materializes expiries at the sim clock; a clock behind the last action is a view-only rewind (no tick). */
  private tick(): void {
    const head = this.log.at(-1);
    if (head !== undefined && this.clock.nowMs < head.atMs) return;
    const r = applyCommand({ dataset: this.dataset }, this.log, { type: 'tick', commandId: `tick@${this.clock.nowMs}`, actor: SIM_CLOCK }, this.clock.nowMs);
    if (r.ok && !r.replayed && r.emitted.length > 0) {
      appendJsonl(this.dirs.live, ACTIONS_FILE, r.emitted);
      this.log = r.log;
    }
  }

  private syncTimer(): void {
    if (this.clock.mode === 'playing' && this.timer === null) {
      this.timer = setInterval(() => {
        void this.mutex.run(() => {
          if (this.clock.mode !== 'playing') return;
          this.setClock({ ...this.clock, nowMs: this.clock.nowMs + this.playStepMs * this.clock.speed });
        });
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
    return etWallClockToEpoch(etDateOf(this.snapshotMs), secs);
  }

  /** Boot: replay data/live (injected rows, then the action log) so a restart keeps the demo state. */
  private replayLive(): void {
    for (const rec of readJsonl<InjectedRecord>(this.dirs.live, EVENTS_FILE)) {
      const r = appendEventText(this.dataset, `${EVENT_COLUMNS.join(',')}\n${rec.row}`, { nowMs: rec.atMs });
      if (r.accepted.length === 1) this.dataset = r.dataset;
      else this.bootWarnings.push(`events.jsonl: row not re-applied (${[...r.rejected.map((x) => x.reason), ...r.duplicates.map((x) => x.reason)].join('; ')}): ${rec.row}`);
    }
    const actions = readJsonl<ActionEvent>(this.dirs.live, ACTIONS_FILE);
    const contiguous = actions.every((a, i) => a.seq === i + 1);
    if (contiguous) this.log = Object.freeze(actions.map((a) => Object.freeze(a)));
    else this.bootWarnings.push('actions.jsonl: seq is not contiguous; action log not restored');
    const lastAction = this.log.at(-1)?.atMs ?? 0;
    const lastInjected = Math.max(0, ...readJsonl<InjectedRecord>(this.dirs.live, EVENTS_FILE).map((r) => r.atMs));
    this.clock = { ...this.clock, nowMs: Math.max(this.snapshotMs, lastAction, lastInjected) };
    if (this.dataset !== this.baseDataset) this.datasetVersion++;
  }
}

/** The clock stays within the scenario: from the first event to 24 h after the reference instant. */
function clampClock(nowMs: number, base: Dataset, snapshotMs: number): number {
  if (!Number.isFinite(nowMs)) throw new StoreError('BAD_REQUEST', 'clock time must be a finite epoch-ms number');
  const first = Math.min(...base.events.map((e) => e.eventTime));
  return Math.round(Math.min(Math.max(nowMs, first), snapshotMs + 24 * 3_600_000));
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

/** Tests only: drop the singleton so the next getStore() boots from disk again. */
export function disposeStore(): void {
  holder.__lookaheadStore?.dispose();
  delete holder.__lookaheadStore;
}
