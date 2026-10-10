import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_SRC = fileURLToPath(new URL('../src', import.meta.url));
export const DATA_DIR = fileURLToPath(new URL('../../../data/raw', import.meta.url));

export interface Golden {
  rowCounts: Record<string, number>;
  eventTypeCounts: Record<string, number>;
  duplicateEventIds: string[];
  snapshotLabel: string;
}
export const golden = JSON.parse(readFileSync(fileURLToPath(new URL('./golden/reference_dataset.json', import.meta.url)), 'utf8')) as Golden;

/** All CSV texts of the reference package, keyed by file name. */
export function referenceTexts(): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const name of readdirSync(DATA_DIR).filter((n) => n.endsWith('.csv'))) texts[name] = readFileSync(join(DATA_DIR, name), 'utf8');
  return texts;
}

/** Counts data lines independently of the CSV parser: non-blank lines minus the header. */
export function rawDataLineCount(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').length - 1;
}

/** Recursively lists .ts files under a directory. */
export function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? tsFiles(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : [],
  );
}

/** Reference scenario instants are written in tests only (CLAUDE.md rule 5). */
export const et = (hms: string): number => Date.parse(`2026-03-17T${hms}-04:00`);

/** mulberry32: tiny seeded PRNG for deterministic shuffles in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rand = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
