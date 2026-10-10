import 'server-only';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { unzipSync } from 'fflate';
import { diffSnapshot, replay, snapshotAsOfMs, toSnapshotConsultRows, toSnapshotPhysicianRows, type CellDiff, type Dataset, type IngestMapping, type IngestReport } from '@lookahead/engine';
import { MAPPING_FILE, ingestDir } from '@lookahead/engine/loaders';
import { liveDir } from './paths';
import { StoreError } from './store';

/**
 * Dataset swap for judging (Session 7): uploads land in a staging directory
 * under data/live/uploads/<stageId>/, the engine's schema-adaptive ingestion
 * (ingestDir, OQ-45) produces the report, and the replay is checked against
 * the upload's own snapshot files when it has them. Activation is a separate,
 * PIN-protected step (Store.activate).
 */

export interface SnapshotCheck {
  readonly label: string;
  readonly physicians: string;
  readonly consults: string;
  readonly diffCount: number;
  readonly diffs: readonly CellDiff[];
}

export interface StageResult {
  readonly stageId: string;
  readonly files: readonly string[];
  readonly mapping: IngestMapping | null;
  readonly report: IngestReport;
  readonly snapshot: SnapshotCheck | null;
  readonly eventCount: number | null;
  readonly canActivate: boolean;
}

const MAX_LISTED_DIFFS = 200;
const SAFE_NAME = /^[\w .()+-]{1,120}\.csv$/i;

export const uploadsDir = () => join(liveDir(), 'uploads');
const stageDir = (stageId: string) => join(uploadsDir(), stageId);

export function stagePath(stageId: string): string {
  if (!/^[a-z0-9-]{8,64}$/.test(stageId) || !existsSync(stageDir(stageId))) throw new StoreError('UNKNOWN_STAGE', `no staged upload ${stageId}`);
  return stageDir(stageId);
}

/** Uploaded files (CSV or ZIP of CSVs, optional mapping.json) -> staging dir -> ingest report. */
export function stageUpload(files: readonly { name: string; bytes: Uint8Array }[], mapping: IngestMapping | null): StageResult {
  const entries = files.flatMap((f) => (f.name.toLowerCase().endsWith('.zip') ? unzipEntries(f.bytes) : [{ name: basename(f.name), bytes: f.bytes }]));
  const csvs = entries.filter((e) => e.name.toLowerCase().endsWith('.csv'));
  if (csvs.length === 0) throw new StoreError('BAD_REQUEST', 'upload at least one .csv file (or a .zip of them)');
  const stageId = randomUUID();
  const dir = stageDir(stageId);
  mkdirSync(dir, { recursive: true });
  const written = new Set<string>();
  for (const e of csvs) {
    const name = SAFE_NAME.test(e.name) ? e.name : `${e.name.replace(/[^\w .()+-]/g, '_').slice(0, 100)}.csv`;
    if (written.has(name)) throw new StoreError('BAD_REQUEST', `two uploaded files are both named ${name}`);
    written.add(name);
    writeFileSync(join(dir, name), e.bytes);
  }
  const fromZip = entries.find((e) => e.name === MAPPING_FILE);
  if (mapping !== null) writeFileSync(join(dir, MAPPING_FILE), JSON.stringify(mapping, null, 2));
  else if (fromZip !== undefined) writeFileSync(join(dir, MAPPING_FILE), fromZip.bytes);
  return ingestStage(stageId);
}

/** Writes mapping.json for a staged upload and re-ingests it. */
export function remapStage(stageId: string, mapping: IngestMapping): StageResult {
  writeFileSync(join(stagePath(stageId), MAPPING_FILE), JSON.stringify(mapping, null, 2));
  return ingestStage(stageId);
}

export function ingestStage(stageId: string): StageResult {
  const dir = stagePath(stageId);
  const r = ingestDir(dir);
  const files = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv')).sort();
  const mappingFile = existsSync(join(dir, MAPPING_FILE));
  return {
    stageId,
    files,
    mapping: mappingFile ? (JSON.parse(readFileSync(join(dir, MAPPING_FILE), 'utf8')) as IngestMapping) : null,
    report: r.report,
    snapshot: r.dataset === null ? null : snapshotCheck(r.dataset),
    eventCount: r.dataset?.events.length ?? null,
    canActivate: r.dataset !== null,
  };
}

/** Replay at the snapshot's own instant vs the snapshot rows (brief #1: "match the reference snapshot"). */
export function snapshotCheck(d: Dataset): SnapshotCheck | null {
  if (d.snapshot === null) return null;
  const at = snapshotAsOfMs(d);
  if (at === null) return null;
  const st = replay(d, at);
  const diff = diffSnapshot({ physicians: toSnapshotPhysicianRows(st), consults: toSnapshotConsultRows(st) }, d.snapshot);
  const short = (s: string) => s.replace(' rows match', '');
  return { label: d.snapshot.label, physicians: short(diff.summary.physicians), consults: short(diff.summary.consults), diffCount: diff.diffs.length, diffs: diff.diffs.slice(0, MAX_LISTED_DIFFS) };
}

function unzipEntries(bytes: Uint8Array): { name: string; bytes: Uint8Array }[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new StoreError('BAD_REQUEST', `could not read the zip file: ${e instanceof Error ? e.message : String(e)}`);
  }
  return Object.entries(files)
    .filter(([path]) => !path.endsWith('/') && !path.startsWith('__MACOSX/') && !basename(path).startsWith('.'))
    .map(([path, data]) => ({ name: basename(path), bytes: data }));
}
