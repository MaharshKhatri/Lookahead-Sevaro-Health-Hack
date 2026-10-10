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
