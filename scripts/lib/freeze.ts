/** Shared by the golden-freeze script and tests: stable JSON and the frozen shapes. */
import type { ActionLog, CoverageProjection, DecisionReport } from '@lookahead/engine';

/** JSON with object keys sorted recursively, so fixtures diff cleanly. */
export function stableJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

/** Timeline points as compact tuples: [tMs, hospitalId, required, staffed, staffedConfirmed, staffedExpected, staffedIds]. */
function compactCoverage(c: CoverageProjection) {
  const tuples = (points: CoverageProjection['timeline']) =>
    points.flatMap((p) => Object.entries(p.perHospital).map(([h, x]) => [p.tMs, h, x.required, x.staffed, x.staffedConfirmed, x.staffedExpected, [...x.staffedIds].join(' ')]));
  return { ...c, timeline: tuples(c.timeline), timelineExcludingArrivals: tuples(c.timelineExcludingArrivals) };
}

/**
 * The decide() report minus the bulkiest derived matrices (routability detail
 * strings, per-consult event-id lists, per-point coverage objects), which are
 * re-derivable from the frozen routes, counts, stage histories and tuples.
 */
export function freezeDecision(d: DecisionReport): unknown {
  const { routability, ...detection } = d.detection;
  void routability; // dropped from the fixture (bulk; re-derivable)
  const consults = Object.fromEntries(Object.entries(detection.state.consults).map(([k, c]) => [k, { ...c, events: c.events.length }]));
  const out = {
    ...d,
    detection: { ...detection, coverage: compactCoverage(detection.coverage), state: { ...detection.state, consults } },
    decisionCoverage: compactCoverage(d.decisionCoverage),
    whatIf: { ...d.whatIf, after: d.whatIf.after === null ? null : { ...d.whatIf.after, coverage: compactCoverage(d.whatIf.after.coverage) } },
  };
  return JSON.parse(JSON.stringify(out));
}

export function freezeLog(log: ActionLog): unknown {
  return JSON.parse(JSON.stringify(log));
}

/**
 * Subset deep-equality: every key present in `golden` must exist in `actual`
 * with a deep-equal value; extra keys in `actual` are allowed (additive
 * layers). Arrays must have the same length and compare element-wise.
 * Returns the list of paths that differ (empty = frozen fields intact).
 */
export function subsetDiffs(actual: unknown, golden: unknown, path = '$'): string[] {
  if (Array.isArray(golden)) {
    if (!Array.isArray(actual)) return [`${path}: expected array, got ${typeof actual}`];
    if (actual.length !== golden.length) return [`${path}: length ${actual.length} != frozen ${golden.length}`];
    return golden.flatMap((g, i) => subsetDiffs(actual[i], g, `${path}[${i}]`));
  }
  if (golden !== null && typeof golden === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [`${path}: expected object, got ${actual === null ? 'null' : typeof actual}`];
    const a = actual as Record<string, unknown>;
    return Object.entries(golden as Record<string, unknown>).flatMap(([k, g]) => (k in a ? subsetDiffs(a[k], g, `${path}.${k}`) : [`${path}.${k}: missing`]));
  }
  return Object.is(actual, golden) || actual === golden ? [] : [`${path}: ${JSON.stringify(actual)} != frozen ${JSON.stringify(golden)}`];
}
