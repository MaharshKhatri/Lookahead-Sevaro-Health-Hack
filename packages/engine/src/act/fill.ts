import type { NeedChange, RoutableAt } from '../decide/whatif';
import type { Need } from '../decide/types';
import type { AcceptedOffer } from '../detect/staffing';
import { etClock } from '../detect/staffing';
import { ELIGIBILITY_NEED_KINDS } from '../policy';
import type { EpochMs } from '../types';
import type { CoverageEffect, FrozenNeed } from './types';

/**
 * Brief "Act": "stop sending offers once the gap is filled". OQ-40
 * (NEED_FILLED_RULE): a need is filled when an accepted offer whose scope
 * includes the need's hospital has started inside the need, and no qualifying
 * need (DEADLOCK_NOW / HARD_GAP, OQ-30) remains at that hospital from that
 * start to the need's end. The time before the relief comes online cannot be
 * filled by any offer, so it does not keep the need open.
 */

export interface FillStatus {
  readonly needId: string;
  readonly filled: boolean;
  readonly reliefStartMs: EpochMs | null;
  readonly detail: string;
}

export function frozenNeed(n: Need): FrozenNeed {
  return { id: n.id, kind: n.kind, hospitalId: n.hospitalId, hospitalName: n.hospitalName, startMs: n.startMs, endMs: n.endMs };
}

const endOf = (n: { endMs: EpochMs | 'beyond_horizon' }, horizonEndMs: EpochMs) => (n.endMs === 'beyond_horizon' ? horizonEndMs : n.endMs);
const label = (n: { kind: string; hospitalId: string; startMs: EpochMs; endMs: EpochMs | 'beyond_horizon' }) =>
  `${n.kind} ${n.hospitalId} ${etClock(n.startMs)}-${n.endMs === 'beyond_horizon' ? 'beyond' : etClock(n.endMs)}`;

/** `afterNeeds`: needs over the decision projection with every accepted offer staffed. */
export function fillStatus(need: FrozenNeed, accepted: readonly AcceptedOffer[], afterNeeds: readonly Need[], horizonEndMs: EpochMs): FillStatus {
  const end = endOf(need, horizonEndMs);
  const covering = accepted.filter((o) => o.scopeHospitalIds.includes(need.hospitalId) && o.startMs < end && o.endMs > need.startMs);
  if (covering.length === 0) return { needId: need.id, filled: false, reliefStartMs: null, detail: `${label(need)}: no accepted offer covers ${need.hospitalId}` };
  const relief = Math.max(need.startMs, Math.min(...covering.map((o) => o.startMs)));
  const remaining = afterNeeds.filter((a) => a.hospitalId === need.hospitalId && ELIGIBILITY_NEED_KINDS.includes(a.kind) && a.startMs < end && endOf(a, horizonEndMs) > relief);
  return remaining.length === 0
    ? { needId: need.id, filled: true, reliefStartMs: relief, detail: `${label(need)}: filled from ${etClock(relief)} by ${covering.map((o) => o.physicianId).join(', ')}` }
    : { needId: need.id, filled: false, reliefStartMs: relief, detail: `${label(need)}: still open after ${etClock(relief)}: ${remaining.map(label).join(', ')}` };
}

/** Before/after of one acceptance (reuses compareNeeds/projectWithOffers output), frozen into offer_accepted. */
export function coverageEffectOf(changes: readonly NeedChange[], routable: readonly RoutableAt[], filledNeedIds: readonly string[]): CoverageEffect {
  return {
    changes: changes.map((c) => ({ needId: c.before.id, kind: c.before.kind, hospitalId: c.before.hospitalId, startMs: c.before.startMs, endMs: c.before.endMs, outcome: c.outcome, detail: c.detail })),
    routableAtStart: routable.map((r) => ({ hospitalId: r.hospitalId, atMs: r.atMs, count: r.count })),
    filledNeedIds,
  };
}
