/**
 * Display formatting shared by server and client. Every clock value is shown
 * in Eastern time (brief "Synthetic Dataset": the scenario is 07:00-18:20
 * Eastern); never the viewer's local zone (CLAUDE.md rule 4).
 */
export const ET_ZONE = 'America/New_York';

const hms = new Intl.DateTimeFormat('en-GB', { timeZone: ET_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const hm = new Intl.DateTimeFormat('en-GB', { timeZone: ET_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "18:20:00" (ET). */
export function etHms(ms: number): string {
  return hms.format(ms);
}

/** "18:20" (ET). */
export function etHm(ms: number): string {
  return hm.format(ms);
}

export function etEnd(end: number | 'beyond_horizon'): string {
  return end === 'beyond_horizon' ? 'beyond' : etHm(end);
}

/** "in 40 min", "now", "4.8 min ago". */
export function relMinutes(ms: number): string {
  if (Math.abs(ms) < 30_000) return 'now';
  const min = Math.round(Math.abs(ms) / 6_000) / 10;
  const text = min >= 10 ? `${Math.round(min)} min` : `${min} min`;
  return ms > 0 ? `in ${text}` : `${text} ago`;
}

/** "09:41" countdown (mm:ss); negative values clamp to 00:00. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function minutesBetween(a: number, b: number): number {
  return Math.round((b - a) / 60_000);
}

export const severityWord = (s: string) => s.toUpperCase();

export const titleCase = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** HH:mm in a hospital's own IANA zone (hospitals.csv local_timezone), 24-hour; CLAUDE.md rule 4. */
export function localHm(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  } catch {
    return etHm(ms);
  }
}

/** Short zone label for a hospital row, e.g. "CT" from America/Chicago at that instant. */
export function zoneAbbr(ms: number, timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName');
    return (part?.value ?? '').replace(/^([A-Z])[SD]T$/, '$1T');
  } catch {
    return '';
  }
}
