import { parse } from 'csv-parse/sync';
import { DataParseError } from './errors';

export interface CsvRow {
  /** 0-based index among data rows. */
  readonly rowIndex: number;
  /** 1-based line number in the file (header is line 1). */
  readonly line: number;
  /** Untrimmed cell values keyed by trimmed header name. */
  readonly values: Readonly<Record<string, string>>;
  /** Number of cells actually present on the line (differs from the header only in relaxed mode). */
  readonly cellCount: number;
}

export interface CsvReadOptions {
  /** Header-less input: use these column names and treat every line as data. */
  readonly columns?: readonly string[];
  /** Keep lines whose cell count differs from the header (see CsvRow.cellCount) instead of throwing. */
  readonly relaxColumnCount?: boolean;
}

export interface CsvTable {
  readonly file: string;
  readonly header: readonly string[];
  readonly rows: readonly CsvRow[];
  /** Fully blank lines skipped by the parser (excluding the final newline). */
  readonly blankLines: number;
}

interface ParsedRecord {
  readonly record: string[];
  readonly info: { readonly lines: number };
}

/**
 * Parses CSV text (RFC 4180 quoting, LF or CRLF, optional BOM). By default the
 * first line is the header and every non-blank line must have exactly as many
 * cells as the header; otherwise this throws with file and line.
 */
export function readCsvText(file: string, text: string, options: CsvReadOptions = {}): CsvTable {
  let records: ParsedRecord[];
  try {
    records = parse(text, {
      bom: true,
      info: true,
      skip_empty_lines: true,
      relax_column_count: options.relaxColumnCount === true,
    }) as ParsedRecord[];
  } catch (err) {
    const line = typeof (err as { lines?: unknown }).lines === 'number' ? (err as { lines: number }).lines : null;
    throw new DataParseError(file, line, err instanceof Error ? err.message : String(err));
  }

  let header: string[];
  let body: ParsedRecord[];
  if (options.columns !== undefined) {
    header = [...options.columns];
    body = records;
  } else {
    const [head, ...rest] = records;
    if (head === undefined) throw new DataParseError(file, null, 'file is empty (no header row)');
    header = head.record.map((h) => h.trim());
    body = rest;
    const seen = new Set<string>();
    for (const name of header) {
      if (name === '') throw new DataParseError(file, head.info.lines, 'header has an empty column name');
      if (seen.has(name)) throw new DataParseError(file, head.info.lines, `duplicate column "${name}"`);
      seen.add(name);
    }
  }

  const rows = body.map((r, rowIndex): CsvRow => {
    const values: Record<string, string> = {};
    header.forEach((name, j) => {
      values[name] = r.record[j] ?? '';
    });
    return { rowIndex, line: r.info.lines, values, cellCount: r.record.length };
  });
  return { file, header, rows, blankLines: countBlankLines(text) };
}

function countBlankLines(text: string): number {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.filter((l) => l.trim() === '').length;
}
