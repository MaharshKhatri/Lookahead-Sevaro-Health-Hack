import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dataset } from '../types';
import { readCsvText, type CsvTable } from './csv';
import { ingestDataset, type IngestMapping, type IngestResult } from './ingest';
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

/** File name of the optional header/file mapping overrides inside an upload directory (OQ-45). */
export const MAPPING_FILE = 'mapping.json';

/**
 * Schema-adaptive load of an uploaded package (OQ-45): every *.csv in `dir`
 * plus `dir/mapping.json` if present (an explicit `mapping` argument wins).
 * Never throws for bad data; problems are in the report.
 */
export function ingestDir(dir: string, mapping?: IngestMapping): IngestResult {
  const texts: Record<string, string> = {};
  for (const name of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv'))) texts[name] = readFileSync(join(dir, name), 'utf8');
  const file = join(dir, MAPPING_FILE);
  const fromFile = mapping === undefined && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as IngestMapping) : undefined;
  return ingestDataset(texts, mapping ?? fromFile ?? {});
}
