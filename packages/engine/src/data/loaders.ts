import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dataset } from '../types';
import { readCsvText, type CsvTable } from './csv';
import { parseDataset } from './parse';

/**
 * The only file I/O in the engine (CLAUDE.md rule 3): reads every *.csv in
 * `dir` and hands the texts to the pure parser.
 */
export function loadDataset(dir: string): Dataset {
  const names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv'));
  const texts: Record<string, string> = {};
  for (const name of names) texts[name] = readFileSync(join(dir, name), 'utf8');
  return parseDataset(texts);
}

/** Reads one CSV file into an untyped table (header + string cells), for profiling. */
export function readCsvFile(path: string, displayName: string): CsvTable {
  return readCsvText(displayName, readFileSync(path, 'utf8'));
}
