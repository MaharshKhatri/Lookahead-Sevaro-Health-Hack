import { parse } from 'csv-parse/sync';
import { DataParseError } from './errors';

export interface CsvRow {
  /** 0-based index among data rows. */
  readonly rowIndex: number;
  /** 1-based line number in the file (header is line 1). */
  readonly line: number;
  /** Untrimmed cell values keyed by trimmed header name. */
  readonly values: Readonly<Record<string, string>>;
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
 * Parses CSV text (RFC 4180 quoting, LF or CRLF, optional BOM). Every
 * non-blank line must have exactly as many cells as the header; otherwise
 * this throws with file and line.
 */
export function readCsvText(file: string, text: string): CsvTable {
  let records: ParsedRecord[];
  try {
    records = parse(text, { bom: true, info: true, skip_empty_lines: true }) as ParsedRecord[];
  } catch (err) {
    const line = typeof (err as { lines?: unknown }).lines === 'number' ? (err as { lines: number }).lines : null;
    throw new DataParseError(file, line, err instanceof Error ? err.message : String(err));
  }
  const [head, ...body] = records;
  if (head === undefined) throw new DataParseError(file, null, 'file is empty (no header row)');

  const header = head.record.map((h) => h.trim());
  const seen = new Set<string>();
  for (const name of header) {
    if (name === '') throw new DataParseError(file, head.info.lines, 'header has an empty column name');
    if (seen.has(name)) throw new DataParseError(file, head.info.lines, `duplicate column "${name}"`);
    seen.add(name);
  }

  const rows = body.map((r, rowIndex): CsvRow => {
    const values: Record<string, string> = {};
    header.forEach((name, j) => {
      values[name] = r.record[j] ?? '';
    });
    return { rowIndex, line: r.info.lines, values };
  });
  return { file, header, rows, blankLines: countBlankLines(text) };
}

function countBlankLines(text: string): number {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.filter((l) => l.trim() === '').length;
}
