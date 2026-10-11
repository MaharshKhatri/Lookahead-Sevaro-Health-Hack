/**
 * Every fact the site may state. Values come from the Lookahead repository's
 * own reports on the synthetic Sevaro Challenge 2 data package (one evening,
 * Tuesday 17 March 2026, "now" = 18:20 ET). A value of null is unknown: the
 * component that would show it hides the claim entirely (no placeholder).
 */

export interface Facts {
  readonly events: number;
  readonly hospitals: number;
  readonly physiciansOnShift: number;
  readonly offShiftPhysicians: number;
  readonly snapshotMatch: { readonly physicians: string; readonly consults: string };
  readonly routingFailuresReproduced: string;
  readonly lateEvent: { readonly description: string; readonly lateSeconds: number };
  readonly duplicateEvents: number;
  readonly testCount: number | null;
  readonly rewind: { readonly actualWaitMin: number; readonly anticipatoryWaitMin: number; readonly strokeMinutesAverted: number } | null;
  readonly scale: { readonly hospitals: number; readonly totalMs: number } | null;
  readonly backtestHeadline: string | null;
  readonly team: readonly string[] | null;
}

export const facts: Facts = {
  events: 1164,
  hospitals: 12,
  physiciansOnShift: 8,
  offShiftPhysicians: 6,
  snapshotMatch: { physicians: '8/8', consults: '18/18' },
  routingFailuresReproduced: '4/4',
  lateEvent: { description: 'a video_start event that happened at 18:11:20 but arrived at 18:18:05', lateSeconds: 405 },
  duplicateEvents: 1,
  // docs/test-report.json (pnpm test:report, 2026-10-11): total.tests = 643 (engine 464 + web 179), 0 failed.
  testCount: 643,
  // docs/rewind.json: the Oak Valley stroke consult (CON-2105 in the data) waits 72.5 min on the actual line
  // (still unassigned when the data ends, counted to 19:20 ET) and 21.7 min on the anticipatory line;
  // totals 384.2 (actual) - 333.4 (anticipatory) = 50.8 stroke consult-minutes over the day.
  rewind: { actualWaitMin: 72.5, anticipatoryWaitMin: 21.7, strokeMinutesAverted: 50.8 },
  // docs/SCALE.md: x20 package, 240 hospitals; "full recompute" median 9444 ms (uncached; the live view memoizes it).
  scale: { hospitals: 240, totalMs: 9444 },
  // docs/FORECAST_BACKTEST.md section 2, verbatim. M0 = time-of-day baseline, M1 = persistence, M2 = Lookahead's forecast.
  backtestHeadline: 'M2 improves on M0 in 0 of 5 metrics and on M1 in 4 of 5.',
  // Names are shown only when this list is filled in; otherwise only the team sentence appears.
  team: null,
};

/** The scenario, all times ET on Tuesday 17 March 2026, "now" = 18:20. */
export const scenario = {
  date: 'Tuesday 17 March 2026',
  now: '18:20',
  oakValley: {
    hospital: 'Oak Valley Medical',
    triaged: '18:09:05',
    routingFailures: ['18:09:10', '18:14:10', '18:19:10'],
    why: 'no credentialed physician was available',
  },
  suncrest: {
    hospital: 'Suncrest Medical Pavilion',
    lastHourConsults: 5,
    normalP90: 1,
    strokeTriaged: '18:17:10',
    routingFailure: '18:17:15',
  },
  shiftEnds: { at: '19:00', physicians: 2, note: 'with open consults and unfinished notes' },
  recommendation: {
    physician: 'Dr. Grace Okafor',
    shortName: 'Dr. Okafor',
    window: '18:35–22:35',
    start: '18:35',
    end: '22:35',
    scope: ['Suncrest', 'Northfield', 'Oak Valley'],
    effect: 'both stroke deadlocks end within 15 minutes instead of lasting 40 and 100 minutes',
  },
} as const;

export interface LedgerRow {
  readonly name: string;
  readonly eligible: boolean;
  readonly reason: string;
}

export const ledger: readonly LedgerRow[] = [
  { name: 'Dr. Grace Okafor', eligible: true, reason: 'Opted in, credentialed at all three gap hospitals, 11.5 h rest, under the 60 h cap.' },
  { name: 'Dr. Ben Alvarez', eligible: false, reason: 'Credentialed only at hospitals without a gap.' },
  { name: 'Dr. Hannah Cho', eligible: false, reason: 'Already scheduled at 19:00, so the offer would overlap.' },
  { name: 'Dr. Omar Haddad', eligible: false, reason: 'Not opted in (and scheduled at 20:00).' },
  { name: 'Dr. Lucy Brennan', eligible: false, reason: 'Not opted in.' },
  { name: 'Dr. Ravi Menon', eligible: false, reason: '59 h this week + 2 h = 61 h, over the 60 h cap.' },
];

export const trap = {
  seed: 14,
  text: "A physician who joins with 0 consults becomes the first pick everywhere they're credentialed. Lookahead scopes them to the gap hospitals and seeds their count at the median of on-shift peers (14).",
};

export const saver = {
  citation: 'Saver JL. "Time Is Brain—Quantified." Stroke. 2006.',
  line: 'A published average from Saver (Stroke, 2006): about 1.9 million neurons are lost per minute in a typical large-vessel ischemic stroke.',
};

/** Links come from the environment at build time; a button whose variable is unset is not rendered. */
export const links = {
  demo: process.env.NEXT_PUBLIC_DEMO_URL || null,
  video: process.env.NEXT_PUBLIC_VIDEO_URL || null,
  repo: process.env.NEXT_PUBLIC_REPO_URL || null,
};

export const disclaimer = 'Lookahead is a Rutgers Health Hack 2026 project for Sevaro’s Challenge 2. Independent student project, not affiliated with or endorsed by Sevaro. All data shown is synthetic.';
