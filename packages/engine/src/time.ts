import { DateTime } from 'luxon';
import type { EpochMs } from './types';

/**
 * Brief "Synthetic Dataset": the scenario runs "07:00-18:20 Eastern" and the
 * *_et columns are Eastern wall-clock. ET is the IANA zone America/New_York.
 * Never use the machine's local zone (CLAUDE.md rule 4).
 */
export const ET_ZONE = 'America/New_York';

const SECONDS_PER_DAY = 86_400;

/**
 * Converts an ET wall-clock time on a given ET calendar date to an instant.
 * secondOfDay may exceed one day (e.g. a shift ending after midnight); the
 * extra whole days are added on the calendar, not as fixed 24h spans, so DST
 * days stay correct.
 */
export function etWallClockToEpoch(etDate: string, secondOfDay: number): EpochMs {
  const day = DateTime.fromISO(etDate, { zone: ET_ZONE });
  if (!day.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(etDate)) {
    throw new Error(`invalid ET date "${etDate}" (expected YYYY-MM-DD)`);
  }
  if (!Number.isInteger(secondOfDay) || secondOfDay < 0) {
    throw new Error(`invalid secondOfDay ${secondOfDay}`);
  }
  const extraDays = Math.floor(secondOfDay / SECONDS_PER_DAY);
  const rem = secondOfDay % SECONDS_PER_DAY;
  return day
    .plus({ days: extraDays })
    .set({ hour: Math.floor(rem / 3600), minute: Math.floor((rem % 3600) / 60), second: rem % 60, millisecond: 0 })
    .toMillis();
}

/** ET calendar date (YYYY-MM-DD) containing the instant. */
export function etDateOf(instant: EpochMs): string {
  const date = DateTime.fromMillis(instant, { zone: ET_ZONE }).toISODate();
  if (date === null) throw new Error(`invalid instant ${instant}`);
  return date;
}
