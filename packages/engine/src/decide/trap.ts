import type { DetectionReport } from '../detect';
import { LOW_VOLUME_MAX_CONSULTS } from '../detect/brief-rules';
import { compareRouteCandidates, type RankKey } from '../detect/routing';
import { etClock, isDayShift, shiftCountsAt, shiftsAt } from '../detect/staffing';
import { TRAP_MITIGATION } from '../policy';
import { compareIds } from '../replay/derive';
import type { EpochMs } from '../types';
import type { PrioritySnapshotRow, TrapAnalysis } from './types';

/**
 * Brief "The split-shift trap": "A physician who joins mid-shift starts with
 * zero consults. Under rule 4, routing will send them nearly every call at
 * every hospital they are credentialed for." Deterministic, static priority
 * comparison under routing rules 3-4 at the joiner's start, before and after
 * the OQ-35 mitigations (SCOPE to the need hospitals, SEED a starting count).
 */

export interface Joiner {
  readonly physicianId: string;
  readonly startMs: EpochMs;
  /** null for a scheduled arrival (normal shift, not ours to scope). */
  readonly scopeHospitalIds: readonly string[] | null;
  readonly source: 'split_shift_offer' | 'scheduled_arrival';
}

export function analyzeTrap(detection: DetectionReport, joiner: Joiner): TrapAnalysis {
  const { staffing, state } = detection;
  const credentialed = [...(staffing.credentials.get(joiner.physicianId) ?? [])].sort(compareIds);
  const dayShift = isDayShift(joiner.startMs);
  const limit = dayShift ? LOW_VOLUME_MAX_CONSULTS.day : LOW_VOLUME_MAX_CONSULTS.night;
  const scope = joiner.scopeHospitalIds;
  const outside = scope === null ? [] : credentialed.filter((h) => !scope.includes(h));
  const peers = shiftsAt(staffing, joiner.startMs).filter((s) => s.physicianId !== joiner.physicianId);
  const peerKey = (id: string): RankKey => {
    const shift = peers.find((s) => s.physicianId === id);
    const consults = (state.physicians[id]?.consultsThisShift ?? 0) + (shift?.seededConsults ?? 0);
    const peerLimit = shift?.dayShift === false ? LOW_VOLUME_MAX_CONSULTS.night : LOW_VOLUME_MAX_CONSULTS.day;
    return { physicianId: id, consults, tier: consults <= peerLimit ? 'low_volume_priority' : 'fewest_consults', lastAnsweredMs: state.physicians[id]?.lastAnsweredMs ?? null };
  };
  const peersAt = (h: string) => peers.filter((s) => shiftCountsAt(staffing, s, h)).map((s) => peerKey(s.physicianId));

  // SEED basis: peers on shift at the joiner's start who are credentialed at the scope (or all credentialed) hospitals.
  const basisHospitals = scope ?? credentialed;
  const basis = peers
    .filter((s) => basisHospitals.some((h) => shiftCountsAt(staffing, s, h)))
    .map((s) => ({ physicianId: s.physicianId, consults: peerKey(s.physicianId).consults }))
    .sort((a, b) => a.consults - b.consults || compareIds(a.physicianId, b.physicianId));
  const seed = medianFloor(basis.map((b) => b.consults));
  const recommended = joiner.source === 'split_shift_offer' ? TRAP_MITIGATION : 'seed';
  const useScope = recommended !== 'seed' && scope !== null;
  const useSeed = recommended !== 'scope';

  const row = (h: string, joinerConsults: number, routableHere: boolean): PrioritySnapshotRow => {
    const competitors = peersAt(h);
    const tier = joinerConsults <= limit ? 'low_volume_priority' : 'fewest_consults';
    const me: RankKey = { physicianId: joiner.physicianId, consults: joinerConsults, tier, lastAnsweredMs: state.physicians[joiner.physicianId]?.lastAnsweredMs ?? null };
    const first = routableHere && [me, ...competitors].sort(compareRouteCandidates)[0]?.physicianId === joiner.physicianId;
    const peersText = competitors.map((c) => `${c.physicianId} ${c.consults}`).join(', ') || 'no on-shift peers';
    const why = !routableHere
      ? `outside scope: not routable here during the offer (SCOPE, OQ-35)`
      : `${first ? 'first pick' : 'not first pick'}: ${joinerConsults} consults (${tier === 'low_volume_priority' ? `low volume, <= ${limit} on a ${dayShift ? 'day' : 'night'} shift` : `above the ${limit} low-volume limit`}) vs ${peersText}`;
    return { hospitalId: h, hospitalName: staffing.hospitalNames.get(h) ?? h, inScope: scope === null || scope.includes(h), joinerConsults, joinerTier: tier, competitors, firstPick: first, why };
  };
  const before = credentialed.map((h) => row(h, 0, true));
  const after = credentialed.map((h) => row(h, useSeed ? seed : 0, !useScope || (scope?.includes(h) ?? true)));
  const firstBefore = before.filter((r) => r.firstPick).map((r) => r.hospitalId);
  const firstAfter = after.filter((r) => r.firstPick).map((r) => r.hospitalId);
  const trapWhy = [
    `Without mitigation ${joiner.physicianId} starts at 0 consults; a start at ${etClock(joiner.startMs)} ET is a ${dayShift ? 'day' : 'night'} shift (OQ-10), so low volume means <= ${limit} (rule 3): first pick at ${firstBefore.join(', ') || 'none'}.`,
    scope === null
      ? 'Scheduled shift: routing scope is not ours to limit (advisory only).'
      : `SCOPE: routing limited to ${scope.join(', ')} for the offer window${outside.length > 0 ? `; ${outside.join(', ')} excluded although credentialed` : ''} (OQ-35).`,
    `SEED: starting count ${seed} = median (floor) of ${basis.map((b) => `${b.physicianId} ${b.consults}`).join(', ') || 'no peers'}; ${seed} ${seed > limit ? `> ${limit}, so no low-volume priority` : `<= ${limit}, still low volume`} (OQ-35).`,
    `With ${recommended === 'scope_and_seed' ? 'SCOPE + SEED' : recommended.toUpperCase()}: first pick at ${firstAfter.join(', ') || 'none'}${outside.length > 0 && useScope ? `; nowhere outside scope` : ''}.`,
  ];
  return {
    physicianId: joiner.physicianId,
    source: joiner.source,
    advisory: joiner.source === 'scheduled_arrival',
    startMs: joiner.startMs,
    dayShift,
    lowVolumeLimit: limit,
    credentialedHospitalIds: credentialed,
    scopeHospitalIds: scope,
    credentialedOutsideScope: outside,
    before,
    after,
    seededConsultCount: seed,
    seedBasis: basis,
    recommended,
    trapWhy,
  };
}

/** Median; for an even count, the floor of the two middle values' mean (TRAP_SEED_STATISTIC). */
export function medianFloor(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : Math.floor(((sorted[mid - 1] ?? hi) + hi) / 2);
}
