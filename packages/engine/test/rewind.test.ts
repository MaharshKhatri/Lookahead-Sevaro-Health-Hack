import { describe, expect, it } from 'vitest';
import { REWIND_LATENCY_MIN, engagedMedians, rewind, type Dataset } from '../src';
import { dataset } from './detect.helpers';
import { et } from './helpers';

/**
 * Phase 5: Rewind. Counterfactual replay of the day with Lookahead running
 * (forecast + standby + triggers at 5-min origins), compared on stroke
 * consult-minutes unassigned. Brief: "A solution that only displays current
 * state will score poorly. The value of this challenge is what happens after
 * a problem is detected."
 */
const NOW = et('18:20:00');

describe('rewind', () => {
  const r = rewind(dataset, NOW, { fromMs: et('17:00:00') });

  it('is deterministic and well-formed: 5-min origins from the start to now, three lines whose totals equal their rows, sorted markers', () => {
    expect(JSON.stringify(rewind(dataset, NOW, { fromMs: et('17:00:00') }))).toBe(JSON.stringify(r));
    expect(r.origins.map((o) => o.tMs)).toEqual(Array.from({ length: 17 }, (_, i) => et('17:00:00') + i * 5 * 60_000));
    expect(r.lines.map((l) => l.kind)).toEqual(['actual', 'reactive', 'anticipatory']);
    for (const l of r.lines) expect(l.totalStrokeMinutesUnassigned).toBeCloseTo(l.perConsult.reduce((s, c) => s + c.minutesUnassigned, 0), 1);
    for (let i = 1; i < r.markers.length; i++) expect(r.markers[i]?.tMs ?? 0).toBeGreaterThanOrEqual(r.markers[i - 1]?.tMs ?? 0);
    expect(r.assumptions).toMatchObject(REWIND_LATENCY_MIN);
    expect(r.affectedHospitals.length).toBeGreaterThan(0);
  });

  it('relief never increases unassigned minutes: reactive and anticipatory totals are at most the actual total, row by row', () => {
    const [actual, reactive, anticipatory] = r.lines;
    for (const l of [reactive, anticipatory]) {
      expect(l?.totalStrokeMinutesUnassigned ?? Infinity).toBeLessThanOrEqual(actual?.totalStrokeMinutesUnassigned ?? 0);
      for (let i = 0; i < (actual?.perConsult.length ?? 0); i++) expect(l?.perConsult[i]?.minutesUnassigned ?? Infinity).toBeLessThanOrEqual(actual?.perConsult[i]?.minutesUnassigned ?? 0);
    }
  });

  it('on the reference day the standby is recommended before the spike rule trips and comes online before the reactive offer', () => {
    const pre = r.markers.find((m) => m.kind === 'pre_alert');
    const rule = r.markers.find((m) => m.kind === 'rule_tripped');
    const online = r.markers.find((m) => m.kind === 'online');
    expect(pre && rule && online).toBeTruthy();
    if (!pre || !rule || !online) return;
    expect(pre.tMs).toBeLessThan(rule.tMs);
    const reactive = r.lines.find((l) => l.kind === 'reactive');
    expect(reactive?.onlineAtMs).not.toBeNull();
    expect(online.tMs).toBeLessThan(reactive?.onlineAtMs ?? 0);
    expect(r.firstActions?.onlineAtMs).toBe(online.tMs);
  });

  it('standby disabled => the anticipatory line equals the actual outcome', () => {
    const off = rewind(dataset, NOW, { fromMs: et('17:50:00'), standbyEnabled: false });
    const [actual, , anticipatory] = off.lines;
    expect(anticipatory?.perConsult).toEqual(actual?.perConsult);
    expect(anticipatory?.totalStrokeMinutesUnassigned).toBe(actual?.totalStrokeMinutesUnassigned);
    expect(off.firstActions).toBeNull();
    expect(off.markers.some((m) => m.kind === 'pre_alert' || m.kind === 'activation')).toBe(false);
  });

  it('no future leakage: origins up to o are identical whether or not events ingested after o exist', () => {
    const o = et('18:00:00');
    const trimmed: Dataset = { ...dataset, events: dataset.events.filter((e) => e.ingestedAt <= o) };
    const a = rewind(dataset, o, { fromMs: et('17:40:00') });
    const b = rewind(trimmed, o, { fromMs: et('17:40:00') });
    expect(b.origins).toEqual(a.origins);
    expect(b.markers.filter((m) => m.tMs <= o)).toEqual(a.markers.filter((m) => m.tMs <= o));
  });

  it('engaged medians come from the stream (assignment -> last video/call end) per consult type', () => {
    const m = engagedMedians(dataset, NOW);
    expect(m['Stroke']).toBeGreaterThan(5);
    expect(m['General Neuro']).toBeGreaterThan(5);
    expect(engagedMedians({ ...dataset, events: [] }, NOW)).toEqual({});
  });
});
