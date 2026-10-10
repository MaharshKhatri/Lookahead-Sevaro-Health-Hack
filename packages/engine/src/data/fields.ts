import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import type { ClockTime, EpochMs, TimeBlock } from '../types';

/**
 * Brief "Synthetic Dataset": "All timestamps include an explicit UTC offset".
 * CLAUDE.md rule 4: parse every timestamp with its explicit offset, so a value
 * without "Z" or "+hh:mm"/"-hh:mm" is rejected rather than read in a default zone.
 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

export function parseInstant(raw: string): EpochMs {
  if (!ISO_WITH_OFFSET.test(raw)) {
    throw new Error('expected ISO-8601 date-time with explicit UTC offset, e.g. YYYY-MM-DDThh:mm:ss-04:00');
  }
  const dt = DateTime.fromISO(raw, { setZone: true });
  if (!dt.isValid) throw new Error(`invalid date-time (${dt.invalidExplanation ?? dt.invalidReason ?? 'unknown'})`);
  return dt.toMillis();
}

/** "HH:MM" or "HH:MM:SS", 24-hour. */
export function parseClockTime(raw: string): ClockTime {
  const m = CLOCK.exec(raw);
  if (m === null) throw new Error('expected 24-hour clock time HH:MM or HH:MM:SS');
  const [, hh = '0', mm = '0', ss = '0'] = m;
  return { raw, secondOfDay: Number(hh) * 3600 + Number(mm) * 60 + Number(ss) };
}

/** "HH:MM-HH:MM". An end at or before the start means the block wraps past midnight. */
export function parseTimeBlock(raw: string): TimeBlock {
  const parts = raw.split('-');
  if (parts.length !== 2) throw new Error('expected clock range HH:MM-HH:MM');
  const [a = '', b = ''] = parts;
  const start = parseClockTime(a.trim());
  const end = parseClockTime(b.trim());
  if (start.secondOfDay === end.secondOfDay) throw new Error('clock range has zero length (start equals end)');
  return { raw, start, end, wrapsMidnight: end.secondOfDay < start.secondOfDay };
}

export function parseInteger(raw: string): number {
  if (!INTEGER.test(raw)) throw new Error('expected an integer');
  return Number(raw);
}

export function parseDecimal(raw: string): number {
  if (!DECIMAL.test(raw)) throw new Error('expected a number');
  return Number(raw);
}

export function parseYesNo(raw: string): boolean {
  if (raw === 'Yes') return true;
  if (raw === 'No') return false;
  throw new Error('expected "Yes" or "No"');
}

/** credentialing_matrix.csv cells: "Y" = credentialed, blank = not. */
export function parseYFlag(raw: string): boolean {
  if (raw === 'Y') return true;
  if (raw === '') return false;
  throw new Error('expected "Y" or blank');
}

export function parseIanaZone(raw: string): string {
  if (!IANAZone.isValidZone(raw)) throw new Error('expected an IANA time zone name, e.g. America/Chicago');
  return raw;
}

function field<T>(fn: (trimmed: string) => T) {
  return z.string().transform((s, ctx) => {
    try {
      return fn(s.trim());
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : String(err) });
      return z.NEVER;
    }
  });
}

export const text = z.string().trim();
export const requiredText = z.string().trim().min(1, { message: 'must not be empty' });
export const optionalText = z
  .string()
  .trim()
  .transform((s) => (s === '' ? null : s));
export const instant = field(parseInstant);
export const clockTime = field(parseClockTime);
export const timeBlock = field(parseTimeBlock);
export const integer = field(parseInteger);
export const decimal = field(parseDecimal);
export const yesNo = field(parseYesNo);
export const yFlag = field(parseYFlag);
export const ianaZone = field(parseIanaZone);
export const oneOf = <const T extends readonly [string, ...string[]]>(values: T) => z.string().trim().pipe(z.enum(values));
