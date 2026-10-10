import type { z } from 'zod';
import { FILE_KIND_MIN_HEADER_SCORE, HEADER_ALIASES, HEADER_PREFIX_MIN_LENGTH } from '../policy';
import type { Dataset } from '../types';
import { readCsvText } from './csv';
import { DataParseError } from './errors';
import { DATASET_FILES, parseDataset, type DatasetTexts } from './parse';
import {
  baselineHourlySchema,
  columnsOf,
  coverageRequirementsSchema,
  credentialingFixedSchema,
  credentialingSchema,
  eventStreamSchema,
  hospitalsSchema,
  offShiftRosterSchema,
  physiciansOnShiftSchema,
  snapshotOpenConsultsSchema,
  snapshotPhysiciansSchema,
} from './schemas';

/**
 * Schema-adaptive ingestion (OQ-45) for a data package someone else laid out,
 * e.g. a judge's replacement dataset (brief "What Teams Must Demonstrate" #8:
 * "judges will add new events in the same format"). It works out which file
 * is which and which header is which column, rewrites only the header lines to
 * the exact column names (CLAUDE.md rule 2: map once, in src/data/), checks
 * every row with the same schemas, and only then calls parseDataset. Nothing
 * is guessed silently: every match carries its method, missing columns carry
 * closest-header suggestions, and row errors carry line numbers. Pure; the
 * file reading lives in loaders.ts (ingestDir).
 */

export type DatasetFileKind = keyof typeof DATASET_FILES | 'snapshotPhysicians' | 'snapshotConsults';
export type MatchMethod = 'exact' | 'override' | 'normalized' | 'alias' | 'prefix' | 'hospital_suffix';

export interface ColumnMatch {
  readonly source: string;
  readonly column: string;
  readonly method: MatchMethod;
}

export interface MissingColumn {
  readonly column: string;
  /** Unmapped headers closest to the column (edit distance on normalized names); never applied automatically. */
  readonly suggestions: readonly { readonly header: string; readonly distance: number }[];
}

export interface RowIssue {
  readonly line: number;
  readonly message: string;
}

export interface IngestFileReport {
  readonly source: string;
  readonly kind: DatasetFileKind | null;
  readonly detectedBy: 'name' | 'override' | 'headers' | null;
  /** Name the file is parsed under (snapshot names carry their time label). */
  readonly canonicalName: string | null;
  readonly rows: number;
  readonly mapped: readonly ColumnMatch[];
  /** Headers that map to no column; ignored (credential hospital columns are not listed here). */
  readonly unmapped: readonly string[];
  readonly missing: readonly MissingColumn[];
  readonly rowErrors: readonly RowIssue[];
  /** Row errors beyond MAX_ROW_ERRORS_PER_FILE (counted, not listed). */
  readonly moreRowErrors: number;
  readonly notes: readonly string[];
}

export interface IngestReport {
  readonly ok: boolean;
  readonly files: readonly IngestFileReport[];
  readonly missingFiles: readonly DatasetFileKind[];
  readonly errors: readonly string[];
  /** parseDataset warnings once the package parsed (duplicates, unknown ids, ...). */
  readonly warnings: readonly string[];
  readonly snapshotLabel: string | null;
}

/** mapping.json: optional overrides, applied before any automatic match. */
export interface IngestMapping {
  /** source file name -> kind ("events") or canonical file name ("event_stream.csv"). */
  readonly files?: Readonly<Record<string, string>>;
  /** kind, canonical file name or source file name -> { source header: column }. */
  readonly columns?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Time label for snapshot files whose names carry none (e.g. "1820", OQ-13). */
  readonly snapshotLabel?: string;
}

export interface IngestResult {
  readonly dataset: Dataset | null;
  readonly report: IngestReport;
  /** The texts as parsed: canonical file names, canonical header lines. */
  readonly texts: DatasetTexts;
}

export const MAX_ROW_ERRORS_PER_FILE = 50;

const REQUIRED_KINDS = Object.keys(DATASET_FILES) as (keyof typeof DATASET_FILES)[];
const ALL_KINDS: readonly DatasetFileKind[] = [...REQUIRED_KINDS, 'snapshotPhysicians', 'snapshotConsults'];

const SCHEMAS: Readonly<Record<Exclude<DatasetFileKind, 'credentials'>, z.AnyZodObject>> = {
  events: eventStreamSchema,
  hospitals: hospitalsSchema,
  physiciansOnShift: physiciansOnShiftSchema,
  offShiftRoster: offShiftRosterSchema,
  baselineHourly: baselineHourlySchema,
  coverageRequirements: coverageRequirementsSchema,
  snapshotPhysicians: snapshotPhysiciansSchema,
  snapshotConsults: snapshotOpenConsultsSchema,
};

const columnsFor = (kind: DatasetFileKind): readonly string[] => (kind === 'credentials' ? columnsOf(credentialingFixedSchema) : columnsOf(SCHEMAS[kind]));

const SNAPSHOT_STEM: Readonly<Record<'snapshotPhysicians' | 'snapshotConsults', string>> = { snapshotPhysicians: 'snapshot_physicians_', snapshotConsults: 'snapshot_open_consults_' };

/** Lower case, letters and digits only: "Shift (ET)" -> "shiftet", "event_time" -> "eventtime". */
export const normalizeHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

// ------------------------------------------------------------------ header resolution

interface Resolution {
  readonly mapped: ColumnMatch[];
  readonly unmapped: string[];
  readonly missing: MissingColumn[];
  readonly notes: string[];
}

/**
 * Maps one file's headers to its columns: override, exact, normalized, alias,
 * unique prefix (in that order; each header and each column used once).
 */
export function resolveHeaders(kind: DatasetFileKind, header: readonly string[], overrides: Readonly<Record<string, string>> = {}, hospitalIds: readonly string[] = []): Resolution {
  const columns = columnsFor(kind);
  const aliases = HEADER_ALIASES[kind] ?? {};
  const byHeader = new Map<string, ColumnMatch>();
  const claimed = new Set<string>();
  const notes: string[] = [];
  const assign = (source: string, column: string, method: MatchMethod) => {
    byHeader.set(source, { source, column, method });
    claimed.add(column);
  };
  const free = (h: string) => !byHeader.has(h);

  for (const [source, column] of Object.entries(overrides)) {
    if (!header.includes(source)) notes.push(`override "${source}" -> ${column}: no such header in this file`);
    else if (kind !== 'credentials' && !columns.includes(column)) notes.push(`override "${source}" -> ${column}: ${column} is not a column of this file`);
    else if (!claimed.has(column)) assign(source, column, 'override');
  }
  for (const h of header) if (free(h) && columns.includes(h) && !claimed.has(h)) assign(h, h, 'exact');
  for (const h of header) {
    if (!free(h)) continue;
    const c = columns.find((col) => !claimed.has(col) && normalizeHeader(col) === normalizeHeader(h));
    if (c !== undefined) assign(h, c, 'normalized');
  }
  for (const h of header) {
    if (!free(h)) continue;
    const c = columns.find((col) => !claimed.has(col) && (aliases[col] ?? []).some((a) => normalizeHeader(a) === normalizeHeader(h)));
    if (c !== undefined) assign(h, c, 'alias');
  }
  for (const h of header) {
    const n = normalizeHeader(h);
    if (!free(h) || n.length < HEADER_PREFIX_MIN_LENGTH) continue;
    const hits = columns.filter((col) => !claimed.has(col) && normalizeHeader(col).startsWith(n));
    if (hits.length === 1 && hits[0] !== undefined) assign(h, hits[0], 'prefix');
  }

  let rest = header.filter(free);
  if (kind === 'credentials') {
    // Brief "Credentialing matrix": "Column headers are hospital IDs without the SYN- prefix."
    for (const h of rest) {
      if (hospitalIds.includes(h)) continue;
      const hit = hospitalIds.filter((id) => normalizeHeader(id.slice(id.lastIndexOf('-') + 1)) === normalizeHeader(h));
      if (hit.length === 1 && hit[0] !== undefined) byHeader.set(h, { source: h, column: hit[0], method: 'hospital_suffix' });
    }
    rest = header.filter(free).filter((h) => !hospitalIds.includes(h));
    if (rest.length > 0) notes.push(`not a known hospital id (kept as a hospital column): ${rest.join(', ')}`);
    rest = [];
  }

  const missing = columns
    .filter((c) => !claimed.has(c))
    .map((column) => ({ column, suggestions: suggest(column, aliases[column] ?? [], header.filter(free)) }));
  const mapped = header.flatMap((h) => {
    const m = byHeader.get(h);
    return m === undefined ? [] : [m];
  });
  return { mapped, unmapped: rest, missing, notes };
}

function suggest(column: string, aliases: readonly string[], candidates: readonly string[]): MissingColumn['suggestions'] {
  const targets = [column, ...aliases].map(normalizeHeader);
  return candidates
    .map((header) => ({ header, distance: Math.min(...targets.map((t) => editDistance(normalizeHeader(header), t))) }))
    .sort((a, b) => a.distance - b.distance || (a.header < b.header ? -1 : 1))
    .slice(0, 3);
}

// ------------------------------------------------------------------ file kind detection

interface SourceFile {
  readonly source: string;
  readonly text: string;
  readonly header: readonly string[];
  readonly rows: number;
}

function kindFromName(name: string): { kind: DatasetFileKind; label: string | null } | null {
  for (const k of REQUIRED_KINDS) if (name === DATASET_FILES[k] || normalizeHeader(name.replace(/\.csv$/i, '')) === normalizeHeader(DATASET_FILES[k].replace(/\.csv$/, ''))) return { kind: k, label: null };
  const n = normalizeHeader(name.replace(/\.csv$/i, ''));
  for (const k of ['snapshotPhysicians', 'snapshotConsults'] as const) {
    const stem = normalizeHeader(SNAPSHOT_STEM[k]);
    if (n.startsWith(stem)) return { kind: k, label: n.slice(stem.length) || null };
  }
  return null;
}

function kindFromOverride(value: string): DatasetFileKind | null {
  if ((ALL_KINDS as readonly string[]).includes(value)) return value as DatasetFileKind;
  return kindFromName(value)?.kind ?? null;
}

const isIdLike = (h: string) => /^[A-Za-z]{2,}-\d+$/.test(h) || /^\d{2,}$/.test(h);

/** Share of the kind's columns that this header resolves to (no overrides, no suggestions). */
function headerScore(kind: DatasetFileKind, header: readonly string[]): number {
  const r = resolveHeaders(kind, header);
  const cols = columnsFor(kind);
  if (kind === 'credentials') return header.filter(isIdLike).length >= 2 && r.missing.length === 0 ? 1 : 0;
  return (cols.length - r.missing.length) / cols.length;
}

// ------------------------------------------------------------------ main entry

export function ingestDataset(texts: DatasetTexts, mapping: IngestMapping = {}): IngestResult {
  const errors: string[] = [];
  const sources: SourceFile[] = [];
  for (const source of Object.keys(texts).sort()) {
    if (!/\.csv$/i.test(source)) continue;
    try {
      const t = readCsvText(source, texts[source] ?? '');
      sources.push({ source, text: texts[source] ?? '', header: t.header, rows: t.rows.length });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // 1. Which file is which: override, then name, then headers.
  const assigned = new Map<string, { kind: DatasetFileKind; by: IngestFileReport['detectedBy']; label: string | null }>();
  const taken = new Map<DatasetFileKind, string>();
  const claim = (s: SourceFile, kind: DatasetFileKind, by: IngestFileReport['detectedBy'], label: string | null) => {
    const prior = taken.get(kind);
    if (prior !== undefined) {
      errors.push(`${s.source}: also looks like the ${kind} file (already ${prior}); add a "files" entry to mapping.json`);
      return;
    }
    taken.set(kind, s.source);
    assigned.set(s.source, { kind, by, label });
  };
  for (const s of sources) {
    const o = mapping.files?.[s.source];
    if (o === undefined) continue;
    const kind = kindFromOverride(o);
    if (kind === null) errors.push(`mapping.json files: "${o}" is not a dataset file kind or name`);
    else claim(s, kind, 'override', kindFromName(o)?.label ?? kindFromName(s.source)?.label ?? null);
  }
  for (const s of sources) {
    if (assigned.has(s.source)) continue;
    const byName = kindFromName(s.source);
    if (byName !== null) claim(s, byName.kind, 'name', byName.label);
  }
  for (const s of sources) {
    if (assigned.has(s.source)) continue;
    const scored = ALL_KINDS.filter((k) => !taken.has(k))
      .map((k) => ({ k, score: headerScore(k, s.header) }))
      .sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    if (best !== undefined && best.score >= FILE_KIND_MIN_HEADER_SCORE && (second === undefined || second.score < best.score)) {
      claim(s, best.k, 'headers', /(\d{3,4})/.exec(s.source)?.[1] ?? null);
    }
  }

  // 2. Headers -> columns; hospitals first so credential hospital columns can be recognised.
  const hospitalSource = taken.get('hospitals');
  const hospitalIds = hospitalSource === undefined ? [] : hospitalIdsOf(sources.find((s) => s.source === hospitalSource), mapping);
  const snapshotLabel = snapshotLabelOf(assigned, mapping);
  const canonical: Record<string, string> = {};
  const files: IngestFileReport[] = sources.map((s) => {
    const a = assigned.get(s.source);
    if (a === undefined) return fileReport(s, null, null, null, emptyResolution(s.header), [], 0, ['not recognised as a dataset file; ignored']);
    const r = resolveHeaders(a.kind, s.header, overridesFor(mapping, a.kind, s.source), hospitalIds);
    const name = canonicalName(a.kind, snapshotLabel);
    const notes = [...r.notes];
    if (name === null) notes.push('snapshot file has no time label: name it snapshot_physicians_HHMM.csv / snapshot_open_consults_HHMM.csv or set "snapshotLabel" in mapping.json; snapshot not loaded');
    if (name === null || r.missing.length > 0) return fileReport(s, a.kind, a.by, name, r, [], 0, notes);
    const text = rewriteHeader(s.text, s.header, r.mapped);
    const { issues, more } = rowIssues(name, text, a.kind);
    if (issues.length === 0) canonical[name] = text;
    return fileReport(s, a.kind, a.by, name, r, issues, more, notes);
  });

  const missingFiles = REQUIRED_KINDS.filter((k) => !taken.has(k));
  const blocked = errors.length > 0 || missingFiles.length > 0 || files.some((f) => f.kind !== null && (f.missing.length > 0 || f.rowErrors.length > 0));
  let dataset: Dataset | null = null;
  if (!blocked) {
    try {
      dataset = parseDataset(canonical);
    } catch (e) {
      errors.push(e instanceof DataParseError || e instanceof Error ? e.message : String(e));
    }
  }
  return {
    dataset,
    texts: canonical,
    report: { ok: dataset !== null, files, missingFiles, errors, warnings: dataset?.warnings ?? [], snapshotLabel: dataset?.snapshot?.label ?? snapshotLabel },
  };
}

function overridesFor(mapping: IngestMapping, kind: DatasetFileKind, source: string): Readonly<Record<string, string>> {
  const c = mapping.columns ?? {};
  const fileName = kind in DATASET_FILES ? DATASET_FILES[kind as keyof typeof DATASET_FILES] : null;
  return { ...(c[kind] ?? {}), ...(fileName === null ? {} : (c[fileName] ?? {})), ...(c[source] ?? {}) };
}

function snapshotLabelOf(assigned: ReadonlyMap<string, { kind: DatasetFileKind; label: string | null }>, mapping: IngestMapping): string | null {
  if (mapping.snapshotLabel !== undefined && mapping.snapshotLabel !== '') return mapping.snapshotLabel;
  const labels = [...assigned.values()].filter((a) => a.kind === 'snapshotPhysicians' || a.kind === 'snapshotConsults').map((a) => a.label);
  return labels.find((l): l is string => l !== null) ?? null;
}

function canonicalName(kind: DatasetFileKind, label: string | null): string | null {
  if (kind === 'snapshotPhysicians' || kind === 'snapshotConsults') return label === null ? null : `${SNAPSHOT_STEM[kind]}${label}.csv`;
  return DATASET_FILES[kind];
}

function hospitalIdsOf(s: SourceFile | undefined, mapping: IngestMapping): string[] {
  if (s === undefined) return [];
  const r = resolveHeaders('hospitals', s.header, overridesFor(mapping, 'hospitals', s.source));
  const idHeader = r.mapped.find((m) => m.column === 'hospital_id')?.source;
  if (idHeader === undefined) return [];
  try {
    return readCsvText(s.source, s.text).rows.map((row) => (row.values[idHeader] ?? '').trim()).filter((v) => v !== '');
  } catch {
    return [];
  }
}

/** Replaces only the header line; data lines are kept byte for byte. */
function rewriteHeader(text: string, header: readonly string[], mapped: readonly ColumnMatch[]): string {
  const body = text.replace(/^\uFEFF/, '');
  const nl = body.search(/\r?\n/);
  const rest = nl === -1 ? '' : body.slice(nl);
  const to = new Map(mapped.map((m) => [m.source, m.column]));
  const cell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return header.map((h) => cell(to.get(h) ?? h)).join(',') + rest;
}

/** Every row checked with the same schema parseDataset uses; up to MAX_ROW_ERRORS_PER_FILE listed. */
function rowIssues(name: string, text: string, kind: DatasetFileKind): { issues: RowIssue[]; more: number } {
  const table = readCsvText(name, text);
  const schema = kind === 'credentials' ? credentialingSchema(table.header.filter((h) => !columnsOf(credentialingFixedSchema).includes(h))) : SCHEMAS[kind];
  const issues: RowIssue[] = [];
  let more = 0;
  for (const row of table.rows) {
    const result = schema.safeParse(row.values);
    if (result.success) continue;
    if (issues.length >= MAX_ROW_ERRORS_PER_FILE) {
      more++;
      continue;
    }
    const message = result.error.issues.map((i) => `column "${String(i.path[0] ?? '?')}" value "${row.values[String(i.path[0] ?? '')] ?? ''}": ${i.message}`).join('; ');
    issues.push({ line: row.line, message });
  }
  return { issues, more };
}

const emptyResolution = (header: readonly string[]): Resolution => ({ mapped: [], unmapped: [...header], missing: [], notes: [] });

function fileReport(
  s: SourceFile,
  kind: DatasetFileKind | null,
  by: IngestFileReport['detectedBy'],
  canonicalName: string | null,
  r: Resolution,
  rowErrors: readonly RowIssue[],
  moreRowErrors: number,
  notes: readonly string[],
): IngestFileReport {
  return { source: s.source, kind, detectedBy: by, canonicalName, rows: s.rows, mapped: r.mapped, unmapped: r.unmapped, missing: r.missing, rowErrors, moreRowErrors, notes };
}
