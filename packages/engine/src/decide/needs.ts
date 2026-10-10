import type { DetectionReport } from '../detect';
import { intervalCauses, type CoverageInterval, type CoverageProjection } from '../detect/coverage';
import { dedupeRefs } from '../detect/routing';
import { etClock, shiftCountsAt, type StaffingModel } from '../detect/staffing';
import { DEADLOCK_DEFAULT_WINDOW_MIN, ELIGIBILITY_NEED_KINDS, NEED_KIND_SEVERITY } from '../policy';
import { compareIds } from '../replay/derive';
import type { EpochMs } from '../types';
import { fnv1a } from '../util/hash';
import type { GapHospital, Need, NeedKind } from './types';

/**
 * Needs model: what the Decide layer must address (brief "Problem to Solve":
 * Detect -> Decide). DEADLOCK_NOW comes from routing deadlocks (rule 5);
 * HARD_GAP and AT_RISK from the OQ-29 coverage classification. Needs must
 * start within the detection horizon; their ends come from the (longer)
 * decision projection passed in (OQ-31).
 */
export function computeNeeds(detection: DetectionReport, decisionCoverage: CoverageProjection, staffing: StaffingModel, startCutoffMs?: EpochMs): Need[] {
  // Default: needs must start inside the detection horizon. The what-if passes the decision-projection end so a gap that reopens when an offer ends is not hidden (OQ-31).
  const cutoff = startCutoffMs ?? detection.nowMs + detection.horizonMin * 60_000;
  return [
    ...deadlockNeeds(detection, decisionCoverage, staffing),
    ...decisionCoverage.classification.filter((c) => c.startMs <= cutoff).map((c) => coverageNeed(detection, decisionCoverage, staffing, c)),
  ].sort((a, b) => a.startMs - b.startMs || kindOrder(a.kind) - kindOrder(b.kind) || compareIds(a.hospitalId, b.hospitalId));
}

const kindOrder = (k: NeedKind) => (k === 'DEADLOCK_NOW' ? 0 : k === 'HARD_GAP' ? 1 : 2);
const needId = (kind: NeedKind, hospitalId: string, key: EpochMs | string) => `need-${fnv1a(`${kind}|${hospitalId}|${key}`)}`;

/** One DEADLOCK_NOW per hospital with deadlocked consults; ends at the first known relief (OQ-32). */
function deadlockNeeds(detection: DetectionReport, coverage: CoverageProjection, staffing: StaffingModel): Need[] {
  const byHospital = new Map<string, typeof detection.deadlocks>();
  for (const d of detection.deadlocks) byHospital.set(d.hospitalId, [...(byHospital.get(d.hospitalId) ?? []), d]);
  return [...byHospital].map(([hospitalId, deadlocks]) => {
    const relief = staffing.shifts
      .filter((s) => s.source !== 'on_shift_roster' && s.startMs > detection.nowMs && s.startMs <= coverage.horizonEndMs && shiftCountsAt(staffing, s, hospitalId))
      .sort((a, b) => a.startMs - b.startMs)[0];
    const endMs = relief?.startMs ?? detection.nowMs + DEADLOCK_DEFAULT_WINDOW_MIN * 60_000;
    const items = detection.attention.filter((a) => a.kind === 'ROUTING_DEADLOCK' && a.hospitalIds.includes(hospitalId));
    const consultIds = deadlocks.map((d) => d.consultId);
    const name = staffing.hospitalNames.get(hospitalId) ?? hospitalId;
    const reliefLine =
      relief === undefined
        ? `No arrival or offer credentialed here is known; window set to ${DEADLOCK_DEFAULT_WINDOW_MIN} min (OQ-32).`
        : `Relief expected at ${etClock(relief.startMs)} ET: ${relief.physicianId} (${relief.source === 'split_shift_offer' ? 'accepted split-shift offer' : 'scheduled arrival'}, ${relief.confirmation}) is credentialed here (OQ-32).`;
    return {
      // Keyed by the deadlocked consults, not by now, so the id is stable across instants (Act layer refers to it).
      id: needId('DEADLOCK_NOW', hospitalId, [...consultIds].sort(compareIds).join(',')),
      kind: 'DEADLOCK_NOW',
      hospitalId,
      hospitalName: name,
      startMs: detection.nowMs,
      endMs,
      severity: NEED_KIND_SEVERITY.DEADLOCK_NOW,
      strokeAtRisk: deadlocks.some((d) => d.consultType === 'Stroke'),
      consultIds,
      attentionItemIds: items.map((a) => a.id),
      qualifiesForOffers: ELIGIBILITY_NEED_KINDS.includes('DEADLOCK_NOW'),
      required: null,
      staffedConfirmed: null,
      staffedExpected: null,
      rule: 'NEED_DEADLOCK_NOW',
      why: [`Routing rule 5: no routable physician for ${consultIds.join(', ')} at ${name} now.`, reliefLine],
      because: dedupeRefs(deadlocks.flatMap((d) => d.because)),
    };
  });
}

function coverageNeed(detection: DetectionReport, coverage: CoverageProjection, staffing: StaffingModel, c: CoverageInterval): Need {
  const kind: NeedKind = c.status;
  const demand = detection.demand.find((d) => d.hospitalId === c.hospitalId);
  const causes = intervalCauses(detection.state, staffing, coverage.timeline, c.startMs, c.hospitalId, demand);
  const until = c.endMs === 'beyond_horizon' ? `beyond the ${Math.round((coverage.horizonEndMs - coverage.nowMs) / 60_000)}-min decision projection (OQ-31)` : `until ${etClock(c.endMs)} ET`;
  const expected = c.expectedIds.length > 0 ? `; expected (no shift_started known): ${c.expectedIds.join(', ')}` : '';
  const why = [
    kind === 'HARD_GAP'
      ? `Coverage: ${c.hospitalName} needs ${c.required}; staffed ${c.staffedConfirmed} confirmed + ${c.staffedExpected} expected from ${etClock(c.startMs)} ET, ${until}${expected}.`
      : `Coverage met only via expected arrival(s): ${c.hospitalName} needs ${c.required}; ${c.staffedConfirmed} confirmed + ${c.staffedExpected} expected, zero margin, from ${etClock(c.startMs)} ET, ${until}${expected} (OQ-29).`,
    ...causes.map((x) => `Cause: ${x.detail}.`),
  ];
  if (kind === 'AT_RISK') why.push('Advisory: confirm the scheduled arrival; AT_RISK alone does not justify a split-shift offer (OQ-30).');
  const items = detection.attention.filter((a) => a.kind === 'COVERAGE_GAP' && a.hospitalIds.includes(c.hospitalId) && a.timeToImpactMs === Math.max(0, c.startMs - detection.nowMs));
  return {
    id: needId(kind, c.hospitalId, c.startMs),
    kind,
    hospitalId: c.hospitalId,
    hospitalName: c.hospitalName,
    startMs: c.startMs,
    endMs: c.endMs,
    severity: NEED_KIND_SEVERITY[kind],
    strokeAtRisk: Object.values(detection.state.consults).some((x) => x.open && x.hospitalId === c.hospitalId && x.consultType === 'Stroke'),
    consultIds: [],
    attentionItemIds: kind === 'HARD_GAP' ? items.map((a) => a.id) : [],
    qualifiesForOffers: ELIGIBILITY_NEED_KINDS.includes(kind),
    required: c.required,
    staffedConfirmed: c.staffedConfirmed,
    staffedExpected: c.staffedExpected,
    rule: kind === 'HARD_GAP' ? 'NEED_HARD_GAP' : 'NEED_AT_RISK',
    why,
    because: dedupeRefs(causes.flatMap((x) => x.because)),
  };
}

/** Hospitals across needs, with which needs put each there and whether any qualifies for offers (OQ-30). */
export function gapHospitalsOf(needs: readonly Need[]): GapHospital[] {
  const map = new Map<string, Need[]>();
  for (const n of needs) map.set(n.hospitalId, [...(map.get(n.hospitalId) ?? []), n]);
  return [...map]
    .sort((a, b) => compareIds(a[0], b[0]))
    .map(([hospitalId, ns]) => ({
      hospitalId,
      hospitalName: ns[0]?.hospitalName ?? hospitalId,
      needIds: ns.map((n) => n.id),
      kinds: [...new Set(ns.map((n) => n.kind))],
      qualifiesForOffers: ns.some((n) => n.qualifiesForOffers),
    }));
}

/** Need end as an instant: 'beyond_horizon' resolves to the projection end. */
export function needEndMs(n: Need, horizonEndMs: EpochMs): EpochMs {
  return n.endMs === 'beyond_horizon' ? horizonEndMs : n.endMs;
}
