import { describe, expect, it } from 'vitest';
import { COMMAND_ROLES, buildCoordinatorIntel, buildForecastModel, buildStandbyPlan, decide, forecast, type CommandType, type Dataset } from '../src';
import { dataset } from './detect.helpers';
import { et, seededShuffle } from './helpers';

/**
 * Phase 6: incidents, horizon timeline, next best action. Brief "Detect and
 * rank what needs attention, and explain why each item was flagged" and
 * "Recommend an intervention for the top issue"; grouping and ranking are
 * LOOKAHEAD-DEFINED and explainable (link rule + member list on every incident).
 */
const NOW = et('18:20:00');

function intelFor(ds: Dataset) {
  const d = decide(ds, NOW);
  const model = buildForecastModel(ds, d.detection.state, NOW);
  const f = forecast(ds, d.detection.state, NOW, { fit: model.fit });
  const plan = buildStandbyPlan({ dataset: ds, decision: d, model, nowMs: NOW });
  return { d, intel: buildCoordinatorIntel({ dataset: ds, decision: d, forecast: f, plan, log: [], nowMs: NOW }) };
}

describe('incidents (root-cause grouping)', () => {
  const { d, intel } = intelFor(dataset);

  it('every attention item belongs to exactly one incident, raw items stay reachable through memberItemIds, and the reduction is reported', () => {
    const all = intel.incidents.flatMap((i) => i.memberItemIds);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(d.detection.attention.map((a) => a.id).sort());
    expect(intel.reduction.items).toBe(d.detection.attention.length);
    expect(intel.reduction.incidents).toBe(intel.incidents.length);
    expect(intel.reduction.incidents).toBeLessThan(intel.reduction.items);
    console.log(`alert reduction at 18:20: ${intel.reduction.items} items -> ${intel.reduction.incidents} incidents (${intel.reduction.percent}%)`);
  });

  it('groups are explainable: the surge incident links the deadlock, the unassigned breaches and the gap at the surging hospital; the Temporarily Unavailable physician links the breach on their consult', () => {
    const surgeHospital = d.detection.demand.find((x) => x.spike)?.hospitalId ?? '';
    const surge = intel.incidents.find((i) => i.kind === 'HOSPITAL_SURGE');
    expect(surge?.hospitalIds).toContain(surgeHospital);
    expect(surge?.memberItemIds.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(surge?.linkRule).toMatch(/same hospital as the demand spike/);
    const tu = intel.incidents.find((i) => i.kind === 'PHYSICIAN_UNAVAILABLE_WITH_ASSIGNED');
    expect(tu?.memberItemIds.length).toBe(2);
    expect(tu?.strokeAtRisk).toBe(true);
    const dl = intel.incidents.filter((i) => i.kind === 'ROUTING_DEADLOCK');
    for (const x of dl) expect(x.memberItemIds.length).toBeGreaterThanOrEqual(2);
    for (const i of intel.incidents) {
      expect(i.linkRule.length).toBeGreaterThan(10);
      expect(i.memberItemIds[0]).toBe(i.anchorItemId);
      expect(i.because.length).toBeGreaterThan(0);
    }
    // Incidents are ranked like items: by their anchor's score.
    for (let k = 1; k < intel.incidents.length; k++) expect(intel.incidents[k]?.score ?? 0).toBeLessThanOrEqual(intel.incidents[k - 1]?.score ?? 0);
  });

  it('is deterministic across seeded shuffles of the event order (ids, order, members)', () => {
    const a = JSON.stringify(intel);
    for (const seed of [3, 4]) {
      const ds: Dataset = { ...dataset, events: seededShuffle(dataset.events, seed) };
      expect(JSON.stringify(intelFor(ds).intel)).toBe(a);
    }
  });
});

describe('next best action queue', () => {
  const { intel } = intelFor(dataset);

  it('ranks by expected stroke-minutes averted per coordinator minute, stable and explained, with a one-click command the processor accepts by type', () => {
    const q = intel.nextBestActions;
    expect(q.length).toBeGreaterThan(3);
    for (let k = 0; k < q.length; k++) {
      const a = q[k];
      if (a === undefined) continue;
      expect(a.rank).toBe(k + 1);
      expect(a.score).toBeCloseTo(Math.round((a.expectedStrokeMinutesAverted / a.coordinatorMinutes) * 10) / 10, 1);
      if (k > 0) expect(a.score).toBeLessThanOrEqual(q[k - 1]?.score ?? Infinity);
      expect(a.why.length).toBeGreaterThan(0);
      expect(Object.keys(COMMAND_ROLES)).toContain(a.command.type as CommandType);
      expect(COMMAND_ROLES[a.command.type as CommandType]).toContain(a.proposer === 'off_shift_physician' ? 'physician' : a.proposer);
    }
    // The split-shift offer and the standby pre-alert to the sole eligible physician lead the queue at 18:20 (they avert the most stroke-minutes).
    expect(q[0]?.kind).toBe('SPLIT_SHIFT_OFFER');
    expect(q.some((a) => a.kind === 'STANDBY_PREALERT')).toBe(true);
    expect(q.some((a) => a.kind === 'ESCALATE_TO_CLINICAL_LEAD')).toBe(true);
    // Every incident with an action points at an action in the queue.
    for (const i of intel.incidents) if (i.recommendedAction !== null) expect(q.some((a) => a.id === i.recommendedAction?.id)).toBe(true);
  });
});

describe('horizon timeline (next 180 min)', () => {
  const { intel } = intelFor(dataset);

  it('is sorted, within the horizon, and carries shift ends, expected arrivals, surge and gap bands and action deadlines', () => {
    const t = intel.timeline;
    expect(t.toMs - t.fromMs).toBe(180 * 60_000);
    for (let k = 1; k < t.items.length; k++) expect(t.items[k]?.tMs ?? 0).toBeGreaterThanOrEqual(t.items[k - 1]?.tMs ?? 0);
    const kinds = new Set(t.items.map((x) => x.kind));
    for (const k of ['now', 'shift_end', 'arrival_expected', 'surge_band', 'gap_band', 'action_deadline']) expect(kinds, k).toContain(k);
    for (const x of t.items) {
      if (x.kind !== 'action_deadline') expect(x.tMs).toBeGreaterThanOrEqual(t.fromMs);
      if (x.endMs !== null) expect(x.endMs).toBeGreaterThan(x.tMs);
      expect(x.detail.length).toBeGreaterThan(0);
    }
    const bands = t.items.filter((x) => x.kind === 'surge_band');
    expect(bands.some((b) => (b.value ?? 0) >= 0.5)).toBe(true);
  });
});
