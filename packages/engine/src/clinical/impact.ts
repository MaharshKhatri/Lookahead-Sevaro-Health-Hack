import type { RewindConsultLine, RewindReport } from '../rewind/index';
import type { EpochMs } from '../types';
import { BRAIN_AGING_WEEKS_PER_MIN, DELAY_PASS_THROUGH_RATIO, NEURONS_LOST_PER_MIN, SYNAPSES_LOST_PER_MIN } from './constants';

/**
 * Clinical impact of the rewind (final polish sprint, A3). LOOKAHEAD-DEFINED
 * (illustrative): the brief has no clinical outcome model. Stroke
 * consult-minutes averted = max(0, actual - anticipatory) on the rewind's
 * lines; the Saver 2006 per-minute rates (clinical/constants.ts) are applied
 * through DELAY_PASS_THROUGH_RATIO as an extrapolation only. No NNT, never a
 * decision input.
 *
 * With untilMs, each consult contributes only the part of its unassigned
 * interval [receivedMs, receivedMs + minutesUnassigned) that falls before
 * untilMs, so the totals grow with the rewind time slider; at or past every
 * interval end the clipped totals equal the line totals.
 */

export interface ImpactSummary {
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
  readonly actualMin: number;
  readonly reactiveMin: number;
  readonly anticipatoryMin: number;
  readonly strokeMinutesAverted: number;
  readonly neuronsEstimate: number;
  readonly synapsesEstimate: number;
  readonly agingWeeksEstimate: number;
  readonly zero: boolean;
}

const MIN = 60_000;
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Minutes of one consult's unassigned interval that fall before untilMs. */
export function clippedMinutes(row: Pick<RewindConsultLine, 'receivedMs' | 'minutesUnassigned'>, untilMs: EpochMs): number {
  return Math.max(0, Math.min(row.minutesUnassigned, (untilMs - row.receivedMs) / MIN));
}

function lineMinutes(report: RewindReport, kind: 'actual' | 'reactive' | 'anticipatory', untilMs: EpochMs | undefined): number {
  const l = report.lines.find((x) => x.kind === kind);
  if (l === undefined) return 0;
  if (untilMs === undefined) return l.totalStrokeMinutesUnassigned;
  return round1(l.perConsult.reduce((s, c) => s + clippedMinutes(c, untilMs), 0));
}

export function impactSummary(report: RewindReport, opts: { readonly untilMs?: EpochMs } = {}): ImpactSummary {
  const untilMs = opts.untilMs;
  const actualMin = lineMinutes(report, 'actual', untilMs);
  const reactiveMin = lineMinutes(report, 'reactive', untilMs);
  const anticipatoryMin = lineMinutes(report, 'anticipatory', untilMs);
  const averted = round1(Math.max(0, actualMin - anticipatoryMin));
  const delay = averted * DELAY_PASS_THROUGH_RATIO;
  return {
    fromMs: report.fromMs,
    toMs: untilMs ?? report.toMs,
    actualMin,
    reactiveMin,
    anticipatoryMin,
    strokeMinutesAverted: averted,
    neuronsEstimate: delay * NEURONS_LOST_PER_MIN,
    synapsesEstimate: delay * SYNAPSES_LOST_PER_MIN,
    agingWeeksEstimate: round1(delay * BRAIN_AGING_WEEKS_PER_MIN),
    zero: averted <= 0,
  };
}
