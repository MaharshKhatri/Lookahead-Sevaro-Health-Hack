import { describe, expect, it } from 'vitest';
import { parseClockTime, parseDataset, parseInstant, parseTimeBlock } from '../src';
import { referenceTexts } from './helpers';

/** The reference package cut down to its header plus the first `n` data rows of each file. */
function smallPackage(n = 3): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(referenceTexts())) out[name] = text.split(/\r?\n/).slice(0, n + 1).join('\r\n') + '\r\n';
  return out;
}

/** Replaces the first occurrence of `from` on 1-based line `line` of a file. */
function editLine(texts: Record<string, string>, file: string, line: number, from: string, to: string): Record<string, string> {
  const lines = (texts[file] ?? '').split('\r\n');
  const target = lines[line - 1] ?? '';
  if (!target.includes(from)) throw new Error(`test setup: "${from}" not on ${file}:${line}`);
  lines[line - 1] = target.replace(from, to);
  return { ...texts, [file]: lines.join('\r\n') };
}

describe('timestamps (brief "Synthetic Dataset": "All timestamps include an explicit UTC offset")', () => {
  it('parses an offset timestamp to epoch ms UTC', () => {
    expect(parseInstant('2026-03-17T07:00:00-04:00')).toBe(Date.UTC(2026, 2, 17, 11, 0, 0));
    expect(parseInstant('2026-03-17T11:00:00Z')).toBe(Date.UTC(2026, 2, 17, 11, 0, 0));
  });

  it('rejects a timestamp without an offset instead of guessing a zone (CLAUDE.md rule 4)', () => {
    expect(() => parseInstant('2026-03-17T07:00:00')).toThrow(/explicit UTC offset/);
    expect(() => parseInstant('2026-03-17 07:00:00-04:00')).toThrow(/explicit UTC offset/);
  });

  it('rejects impossible dates', () => {
    expect(() => parseInstant('2026-02-30T07:00:00-05:00')).toThrow(/invalid date-time/);
  });
});

describe('clock values (date-less *_et columns)', () => {
  it('parses HH:MM and HH:MM:SS to seconds of day', () => {
    expect(parseClockTime('08:00').secondOfDay).toBe(8 * 3600);
    expect(parseClockTime('18:09:05').secondOfDay).toBe(18 * 3600 + 9 * 60 + 5);
  });

  it('rejects non-24h formats', () => {
    for (const bad of ['8:00', '24:00', '18:60', '18:09:5']) expect(() => parseClockTime(bad), bad).toThrow();
  });

  it('marks a block that ends before it starts as wrapping midnight (coverage block "22:00-07:00")', () => {
    expect(parseTimeBlock('22:00-07:00').wrapsMidnight).toBe(true);
    expect(parseTimeBlock('07:00-16:00').wrapsMidnight).toBe(false);
    expect(() => parseTimeBlock('07:00-07:00')).toThrow(/zero length/);
  });
});

describe('parseDataset errors name the file and line (never silently drop rows)', () => {
  it('a cut-down copy of the reference package parses (integrity gaps are warnings, not errors)', () => {
    const d = parseDataset(smallPackage());
    expect(d.events.length).toBe(3);
    expect(d.hospitals.length).toBe(3);
    expect(d.warnings.some((w) => w.startsWith('baseline_hourly_volume.csv:'))).toBe(true);
  });

  it('lists missing required files', () => {
    const texts = smallPackage();
    delete texts['hospitals.csv'];
    expect(() => parseDataset(texts)).toThrow(/missing required file\(s\): hospitals\.csv/);
  });

  it('rejects an event type outside brief "Event types" with file, line and value', () => {
    const texts = editLine(smallPackage(), 'event_stream.csv', 2, 'shift_started', 'shift_ended');
    expect(() => parseDataset(texts)).toThrow(/event_stream\.csv:2: column "event_type" value "shift_ended"/);
  });

  it('rejects an event_time without an offset with file and line', () => {
    const texts = editLine(smallPackage(), 'event_stream.csv', 3, '2026-03-17T07:00:00-04:00', '2026-03-17T07:00:00');
    expect(() => parseDataset(texts)).toThrow(/event_stream\.csv:3: column "event_time"/);
  });

  it('rejects a renamed column (CLAUDE.md rule 2: column names match the files exactly)', () => {
    const texts = editLine(smallPackage(), 'hospitals.csv', 1, 'local_timezone', 'timezone');
    expect(() => parseDataset(texts)).toThrow(/hospitals\.csv:1: missing column\(s\) "local_timezone"/);
  });

  it('rejects a row with the wrong number of cells', () => {
    const texts = editLine(smallPackage(), 'hospitals.csv', 3, ',B', ',B,extra');
    expect(() => parseDataset(texts)).toThrow(/hospitals\.csv:3/);
  });

  it('rejects an unknown IANA zone in hospitals.csv', () => {
    const texts = editLine(smallPackage(), 'hospitals.csv', 2, 'America/Chicago', 'Central');
    expect(() => parseDataset(texts)).toThrow(/hospitals\.csv:2: column "local_timezone"/);
  });

  it('rejects a credential cell other than "Y" or blank', () => {
    const texts = editLine(smallPackage(), 'credentialing_matrix.csv', 2, ',Y,', ',yes,');
    expect(() => parseDataset(texts)).toThrow(/credentialing_matrix\.csv:2: column "SYN-\d+" value "yes"/);
  });

  it('warns about extra columns, blank lines and a missing snapshot instead of failing', () => {
    const texts = smallPackage();
    texts['hospitals.csv'] = (texts['hospitals.csv'] ?? '').replace(/\r\n/g, ',x\r\n').replace(/\r\n$/, '\r\n\r\n');
    delete texts['snapshot_physicians_1820.csv'];
    texts['notes.csv'] = 'a\r\n1\r\n';
    const d = parseDataset(texts);
    expect(d.snapshot).toBeNull();
    expect(d.warnings).toEqual(
      expect.arrayContaining([
        'hospitals.csv: extra column(s) ignored: x',
        'hospitals.csv: 1 blank line(s) skipped',
        'snapshot: snapshot_physicians_*.csv not found; no reference snapshot loaded',
        'notes.csv: not a recognised dataset file; ignored',
      ]),
    );
  });

  it('accepts LF line endings and a UTF-8 BOM', () => {
    const texts = Object.fromEntries(Object.entries(smallPackage()).map(([k, v]) => [k, `\uFEFF${v.replace(/\r\n/g, '\n')}`]));
    expect(parseDataset(texts).hospitals.length).toBe(3);
  });
});
