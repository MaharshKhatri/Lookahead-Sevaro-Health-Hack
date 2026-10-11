import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDataset, type Dataset } from '../src';
import { referenceTexts, seededShuffle } from './helpers';

/**
 * Generalization fixture (CLAUDE.md rule 5: no answer-key dependence). Builds a
 * data package that is isomorphic to data/raw under an id map, a name map and a
 * +1 day shift, with every file's data rows permuted. Test-only; the engine must
 * produce the same answers (mapped) on both packages.
 */

export interface IdRule {
  readonly re: RegExp;
  readonly prefix: string;
  readonly offset: number;
}

/** Monotone (order-preserving) id maps so that ties broken by id order resolve the same way. */
export const ID_RULES: readonly IdRule[] = [
  { re: /\bPHY-(\d+)\b/g, prefix: 'DOC-', offset: 9000 }, // PHY-001 -> DOC-9001
  { re: /\bSYN-(\d+)\b/g, prefix: 'HOSP-', offset: 200 }, // SYN-005 -> HOSP-205
  { re: /\bCON-(\d+)\b/g, prefix: 'CASE-', offset: 5000 }, // CON-2105 -> CASE-7105
  { re: /\bEVT-(\d+)\b/g, prefix: 'E-', offset: 50000 }, // EVT-01143 -> E-51143
];

export const ORIGINAL_ID = /\b(PHY|CON|SYN|EVT)-\d+\b/;

/** Maps every reference id inside a string (ids, or whole texts). */
export function mapIds(text: string): string {
  let out = text;
  for (const r of ID_RULES) out = out.replace(r.re, (_m, n: string) => `${r.prefix}${Number(n) + r.offset}`);
  return out;
}

/** Day shift for "YYYY-MM-DDThh:mm:ss±hh:mm" values: the calendar date moves by `days`, the clock and offset stay. */
export function shiftIsoDates(text: string, days: number): string {
  return text.replace(/(\d{4})-(\d{2})-(\d{2})(?=T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?[+-]\d{2}:\d{2})/g, (_m, y: string, mo: string, d: string) => {
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(d) + days);
    return new Date(t).toISOString().slice(0, 10);
  });
}

export interface NameMaps {
  readonly hospitals: ReadonlyMap<string, string>;
  readonly physicians: ReadonlyMap<string, string>;
}

/** Invented names, keyed by original name, from the parsed reference package (never typed by hand). */
export function inventNames(reference: Dataset): NameMaps {
  const hospitals = new Map<string, string>();
  reference.hospitals.forEach((h, i) => hospitals.set(h.hospitalName, `Mutant Site ${String.fromCharCode(65 + i)}`));
  const physicians = new Map<string, string>();
  const seen = new Set<string>();
  let i = 0;
  for (const p of [...reference.physiciansOnShift, ...reference.offShiftRoster, ...reference.credentials]) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    physicians.set(p.name, `Dr. Variant ${String(++i).padStart(2, '0')}`);
  }
  return { hospitals, physicians };
}

function renameAll(text: string, maps: NameMaps): string {
  // Longest names first so a name that is a prefix of another is never replaced inside it.
  const pairs = [...maps.hospitals, ...maps.physicians].sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

function permuteRows(text: string, seed: number): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const trailingBlank = lines.at(-1) === '';
  const body = trailingBlank ? lines.slice(0, -1) : lines;
  const [header, ...rows] = body;
  return [header ?? '', ...seededShuffle(rows, seed)].join(eol) + (trailingBlank ? eol : '');
}

export interface MutatedPackage {
  readonly texts: Record<string, string>;
  readonly names: NameMaps;
  readonly dayShift: number;
  readonly mapId: (id: string) => string;
}

/**
 * The mutated package: ids remapped (ID_RULES, including the credentialing
 * header and snapshot files), names replaced, every ISO timestamp shifted by
 * `dayShift` days, data rows permuted per file (header kept, file names kept).
 */
export function mutatedPackage(seed = 1, dayShift = 1): MutatedPackage {
  const original = referenceTexts();
  const names = inventNames(parseDataset(original));
  const texts: Record<string, string> = {};
  let i = 0;
  for (const name of Object.keys(original).sort()) {
    const text = original[name] ?? '';
    texts[name] = permuteRows(renameAll(shiftIsoDates(mapIds(text), dayShift), names), seed * 1000 + i++);
  }
  return { texts, names, dayShift, mapId: mapIds };
}

/** Writes the mutated CSVs into `dir` (created if needed) and returns the package. */
export function writeMutatedPackage(dir: string, seed = 1, dayShift = 1): MutatedPackage {
  const pkg = mutatedPackage(seed, dayShift);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(pkg.texts)) writeFileSync(join(dir, name), text);
  return pkg;
}
