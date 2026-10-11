import { describe, expect, it } from 'vitest';
import { BRAIN_AGING_WEEKS_PER_MIN, DELAY_PASS_THROUGH_RATIO, NEURONS_LOST_PER_MIN, SYNAPSES_LOST_PER_MIN, clippedMinutes, impactSummary, rewind } from '../src';
import { dataset } from './detect.helpers';
import { et } from './helpers';

/**
 * Sprint A3 (LOOKAHEAD-DEFINED, illustrative): clinical impact of the rewind.
 * averted = max(0, actual - anticipatory) stroke consult-minutes; Saver 2006
 * per-minute rates applied through the 1:1 pass-through assumption. No NNT.
 */
const NOW = et('18:20:00');

describe('impactSummary', () => {
  const r = rewind(dataset, NOW, { fromMs: et('17:00:00') });

  it('uses the line totals and the clinical constants', () => {
    const s = impactSummary(r);
    const [actual, reactive, anticipatory] = r.lines;
    expect(s.actualMin).toBe(actual?.totalStrokeMinutesUnassigned);
    expect(s.reactiveMin).toBe(reactive?.totalStrokeMinutesUnassigned);
    expect(s.anticipatoryMin).toBe(anticipatory?.totalStrokeMinutesUnassigned);
    const averted = Math.round(Math.max(0, s.actualMin - s.anticipatoryMin) * 10) / 10;
    expect(s.strokeMinutesAverted).toBe(averted);
    expect(s.neuronsEstimate).toBeCloseTo(averted * DELAY_PASS_THROUGH_RATIO * NEURONS_LOST_PER_MIN, 0);
    expect(s.synapsesEstimate).toBeCloseTo(averted * DELAY_PASS_THROUGH_RATIO * SYNAPSES_LOST_PER_MIN, -3);
    expect(s.agingWeeksEstimate).toBeCloseTo(averted * DELAY_PASS_THROUGH_RATIO * BRAIN_AGING_WEEKS_PER_MIN, 1);
    expect(s.fromMs).toBe(r.fromMs);
    expect(s.toMs).toBe(r.toMs);
    expect(s.zero).toBe(averted <= 0);
    expect(s.zero).toBe(false);
  });

  it('untilMs clips each consult interval: monotone in untilMs, zero before the start, equal to line totals at the horizon', () => {
    const before = impactSummary(r, { untilMs: r.fromMs - 24 * 3600_000 });
    expect(before.actualMin).toBe(0);
    expect(before.strokeMinutesAverted).toBe(0);
    expect(before.zero).toBe(true);
    const at = impactSummary(r, { untilMs: r.evalHorizonMs + 3600_000 });
    expect(at.actualMin).toBeCloseTo(r.lines[0]?.totalStrokeMinutesUnassigned ?? -1, 0);
    let prev = -1;
    for (let t = r.fromMs; t <= r.evalHorizonMs; t += 10 * 60_000) {
      const s = impactSummary(r, { untilMs: t });
      const expected = Math.round((r.lines[0]?.perConsult ?? []).reduce((acc, c) => acc + clippedMinutes(c, t), 0) * 10) / 10;
      expect(s.actualMin).toBe(expected);
      expect(s.actualMin).toBeGreaterThanOrEqual(prev);
      expect(s.strokeMinutesAverted).toBeGreaterThanOrEqual(0);
      prev = s.actualMin;
    }
  });

  it('zero state: standby disabled => anticipatory equals actual, nothing averted', () => {
    const off = rewind(dataset, NOW, { fromMs: et('18:10:00'), standbyEnabled: false });
    const s = impactSummary(off);
    expect(s.anticipatoryMin).toBe(s.actualMin);
    expect(s.strokeMinutesAverted).toBe(0);
    expect(s.neuronsEstimate).toBe(0);
    expect(s.synapsesEstimate).toBe(0);
    expect(s.agingWeeksEstimate).toBe(0);
    expect(s.zero).toBe(true);
  });
});
