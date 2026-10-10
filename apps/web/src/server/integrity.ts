import 'server-only';
import {
  diffSnapshot,
  lateEventImpact,
  referenceSnapshotRows,
  replay,
  toSnapshotConsultRows,
  toSnapshotPhysicianRows,
  type CellDiff,
  type Correction,
  type Dataset,
  type NetworkState,
  type SnapshotConsultCsvRow,
  type SnapshotPhysicianCsvRow,
} from '@lookahead/engine';
import type { IntegritySummaryDTO } from '@/lib/dto';
import type { StoreSnapshot } from './store';

/**
 * Integrity panel (brief "What Teams Must Demonstrate" #1: "Rebuild current
 * state from the event stream, handling late and duplicate events, and match
 * the reference snapshot"). Correct mode is the engine's event-time replay
 * (D-20); naive mode is arrival order at ingested_at (D-21). Everything is
 * computed at the reference instant over the current dataset and cached per
 * dataset version (injected rows can change it).
 */

export interface SliderSample {
  readonly tMs: number;
  /** What a naive (arrival-order) system showed at t. */
  readonly naive: SubjectState;
  /** What Lookahead showed at t (event-time replay of the events known at t). */
  readonly live: SubjectState;
  /** What actually happened at t, as known at the reference instant (late events backdated). */
  readonly hindsight: { readonly derivedState: string; readonly externalVideo: boolean; readonly correctedBy: string | null };
}

export interface SubjectState {
  readonly derivedState: string;
  readonly flags: readonly string[];
  readonly consultStage: string | null;
  readonly consultEnteredMs: number | null;
}

export interface IntegrityReport {
  readonly summary: IntegritySummaryDTO;
  readonly reference: { readonly physicians: readonly SnapshotPhysicianCsvRow[]; readonly consults: readonly SnapshotConsultCsvRow[] } | null;
  readonly correct: { readonly physicians: readonly SnapshotPhysicianCsvRow[]; readonly consults: readonly SnapshotConsultCsvRow[]; readonly diffs: readonly CellDiff[] };
  readonly naive: { readonly physicians: readonly SnapshotPhysicianCsvRow[]; readonly consults: readonly SnapshotConsultCsvRow[]; readonly diffs: readonly CellDiff[] };
  readonly duplicates: NetworkState['integrity']['duplicates'];
  readonly lateEvents: NetworkState['integrity']['lateEvents'];
  readonly corrections: readonly Correction[];
  readonly slider: {
    readonly subject: { readonly physicianId: string; readonly consultId: string | null; readonly eventId: string; readonly windowStartMs: number; readonly windowEndMs: number } | null;
    readonly samples: readonly SliderSample[];
  };
  readonly warnings: readonly string[];
}

const SLIDER_SPAN_MS = 10 * 60_000;
const SLIDER_STEP_MS = 30_000;

let summaryCache: { key: string; value: IntegritySummaryDTO } | null = null;
let reportCache: { key: string; value: IntegrityReport } | null = null;

const keyOf = (s: StoreSnapshot) => `${s.bootId}|${s.datasetVersion}`;

export function integritySummary(s: StoreSnapshot): IntegritySummaryDTO {
  if (summaryCache?.key === keyOf(s)) return summaryCache.value;
  const value = buildSummary(s.dataset, s.snapshotMs, s.baseEventCount);
  summaryCache = { key: keyOf(s), value };
  return value;
}

function buildSummary(dataset: Dataset, atMs: number, baseCount: number): IntegritySummaryDTO {
  const correct = replay(dataset, atMs);
  const naive = replay(dataset, atMs, { mode: 'naive' });
  const ref = dataset.snapshot;
  const dc = ref === null ? null : diffSnapshot({ physicians: toSnapshotPhysicianRows(correct), consults: toSnapshotConsultRows(correct) }, ref);
  const dn = ref === null ? null : diffSnapshot({ physicians: toSnapshotPhysicianRows(naive), consults: toSnapshotConsultRows(naive) }, ref);
  return {
    snapshotLabel: ref?.label ?? null,
    snapshotMs: ref === null ? null : atMs,
    physicians: dc?.summary.physicians ?? 'no reference snapshot',
    consults: dc?.summary.consults ?? 'no reference snapshot',
    diffs: dc?.diffs.length ?? 0,
    naive: { physicians: dn?.summary.physicians ?? '-', consults: dn?.summary.consults ?? '-', diffs: dn?.diffs.length ?? 0 },
    duplicates: correct.integrity.duplicates.length,
    lateEvents: correct.integrity.lateEvents.length,
    warnings: correct.integrity.warnings.length,
    eventCount: dataset.events.length,
    appendedCount: dataset.events.length - baseCount,
  };
}

export function integrityReport(s: StoreSnapshot): IntegrityReport {
  if (reportCache?.key === keyOf(s)) return reportCache.value;
  const value = buildReport(s);
  reportCache = { key: keyOf(s), value };
  return value;
}

function buildReport(s: StoreSnapshot): IntegrityReport {
  const { dataset, snapshotMs } = s;
  const correct = replay(dataset, snapshotMs);
  const naive = replay(dataset, snapshotMs, { mode: 'naive' });
  const ref = dataset.snapshot;
  const rows = (st: NetworkState) => ({ physicians: toSnapshotPhysicianRows(st), consults: toSnapshotConsultRows(st) });
  const c = rows(correct);
  const n = rows(naive);
  const corrections = lateEventImpact(dataset, snapshotMs);
  return {
    summary: integritySummary(s),
    reference: ref === null ? null : referenceSnapshotRows(ref),
    correct: { ...c, diffs: ref === null ? [] : diffSnapshot(c, ref).diffs },
    naive: { ...n, diffs: ref === null ? [] : diffSnapshot(n, ref).diffs },
    duplicates: correct.integrity.duplicates,
    lateEvents: correct.integrity.lateEvents,
    corrections,
    slider: slider(dataset, snapshotMs, corrections),
    warnings: correct.integrity.warnings,
  };
}

/**
 * The late-event story over [reference - 10 min, reference]: the physician
 * whose EXTERNAL_VIDEO_SUSPECTED flag a late event retracted (from
 * lateEventImpact, not a hard-coded id), sampled every 30 s.
 */
function slider(dataset: Dataset, refMs: number, corrections: readonly Correction[]): IntegrityReport['slider'] {
  const flag = corrections.find((c) => c.entity.kind === 'physician' && c.field === 'flag.EXTERNAL_VIDEO_SUSPECTED' && c.before === true);
  if (flag === undefined) return { subject: null, samples: [] };
  const physicianId = flag.entity.id;
  const videoFix = corrections.find((c) => c.eventId === flag.eventId && c.entity.kind === 'physician' && c.field === 'activeVideo');
  const consultId = typeof videoFix?.after === 'string' ? videoFix.after : null;
  const stateFix = corrections.find((c) => c.eventId === flag.eventId && c.entity.id === physicianId && c.field === 'derivedState');
  const subjectOf = (st: NetworkState): SubjectState => {
    const p = st.physicians[physicianId];
    const k = consultId === null ? undefined : st.consults[consultId];
    return { derivedState: p?.derivedState.value ?? '-', flags: p?.flags.map((f) => f.value.code) ?? [], consultStage: k?.stage ?? null, consultEnteredMs: k?.stageEnteredMs ?? null };
  };
  const samples: SliderSample[] = [];
  for (let t = refMs - SLIDER_SPAN_MS; t <= refMs; t += SLIDER_STEP_MS) {
    const live = subjectOf(replay(dataset, t));
    const inWindow = t >= flag.windowStartMs && t < flag.windowEndMs;
    samples.push({
      tMs: t,
      naive: subjectOf(replay(dataset, t, { mode: 'naive' })),
      live,
      hindsight: inWindow
        ? { derivedState: typeof stateFix?.after === 'string' ? stateFix.after : live.derivedState, externalVideo: false, correctedBy: flag.eventId }
        : { derivedState: live.derivedState, externalVideo: live.flags.includes('EXTERNAL_VIDEO_SUSPECTED'), correctedBy: null },
    });
  }
  return { subject: { physicianId, consultId, eventId: flag.eventId, windowStartMs: flag.windowStartMs, windowEndMs: flag.windowEndMs }, samples };
}
