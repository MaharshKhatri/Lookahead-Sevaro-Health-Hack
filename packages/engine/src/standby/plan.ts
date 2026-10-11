import type { DecisionReport } from '../decide';
import { MIN_REST_HOURS, MAX_HOURS_7D } from '../decide/brief-rules';
import { buildLedger } from '../decide/eligibility';
import type { AcceptedOffer } from '../detect/staffing';
import { etClock } from '../detect/staffing';
import type { LedgerEntry, Need, OfferLogEntry } from '../decide/types';
import type { ForecastModel } from '../forecast';
import {
  STANDBY_ACCEPT_BASE,
  STANDBY_ACCEPT_DECLINE_PENALTY,
  STANDBY_APPROVAL_LATENCY_MIN,
  STANDBY_BURDEN_DECLINE_WEIGHT,
  STANDBY_CELL_MIN,
  STANDBY_EMPTY_BENCH_PGAP,
  STANDBY_HORIZON_MIN,
  STANDBY_MAX_SELECTED,
  STANDBY_MIN_GAIN_EUM,
  STANDBY_MIN_WINDOW_MIN,
  STANDBY_ONE_PREALERT_PER_NIGHT,
  STANDBY_SCHEMA_VERSION,
} from '../policy';
import { compareIds } from '../replay/derive';
import type { Dataset, EpochMs, OffShiftPhysician } from '../types';
import { fnv1a } from '../util/hash';
import { buildGapGrid, round1, round3 } from './grid';
import type { GapCell, HospitalRisk, StandbyCandidate, StandbyPlan, StandbySelection, StandbyWindow } from './types';

const HOUR = 3_600_000;
const MIN = 60_000;

export interface StandbyHistory {
  /** Standby pre-alerts sent to each physician tonight (fairness guard 4.5). */
  readonly preAlertsTonight: ReadonlyMap<string, number>;
  /** Pre-alerts plus offers in the trailing 7 days, per physician (shown on the bench). */
  readonly alerts7d: ReadonlyMap<string, number>;
}

export interface StandbyPlanInput {
  readonly dataset: Dataset;
  readonly decision: DecisionReport;
  readonly model: ForecastModel;
  readonly nowMs: EpochMs;
  readonly offerLog?: readonly OfferLogEntry[];
  readonly acceptedOffers?: readonly AcceptedOffer[];
  readonly history?: StandbyHistory;
}

/**
 * 4.2-4.3 Candidates and greedy probabilistic coverage. Eligibility is
 * decided by CALLING the existing split-shift ledger (brief "Coverage and
 * Split-Shift Eligibility", all six rules plus the two offer limits) on the
 * gap-risk hospitals, never by a second copy of the rules.
 */
export function buildStandbyPlan(input: StandbyPlanInput): StandbyPlan {
  const { decision, model, nowMs } = input;
  const roster = input.dataset.offShiftRoster;
  const { cells, hospitals } = buildGapGrid(decision, model, nowMs);
  const horizonEndMs = nowMs + STANDBY_HORIZON_MIN * MIN;
  const riskNeeds = probabilisticNeeds(cells, hospitals, horizonEndMs);
  const ledger = buildLedger({
    detection: decision.detection,
    roster,
    needs: riskNeeds,
    decisionHorizonEndMs: horizonEndMs + STANDBY_CELL_MIN * MIN,
    offerLog: input.offerLog ?? [],
    ...(input.acceptedOffers === undefined ? {} : { acceptedOffers: input.acceptedOffers }),
  });
  const weights = new Map(hospitals.map((h) => [h.hospitalId, h.strokeWeight]));
  const candidates = roster.map((r) => candidateOf(r, ledger.find((e) => e.physicianId === r.physicianId), cells, weights, decision, nowMs, horizonEndMs, input));
  const selected = greedySelect(cells, weights, candidates);
  const totalEUM = hospitals.reduce((s, h) => s + h.eum, 0);
  const totalWeightedEUM = hospitals.reduce((s, h) => s + h.weightedEum, 0);
  const avoided = selected.reduce((s, x) => s + x.valueEUM, 0);
  const coveredHospitals = new Set(selected.flatMap((s) => s.coveredHospitals));
  const emptyBench = hospitals
    .filter((h) => h.maxPGap >= STANDBY_EMPTY_BENCH_PGAP && !coveredHospitals.has(h.hospitalId))
    .map((h) => ({ hospitalId: h.hospitalId, hospitalName: h.hospitalName, maxPGap: h.maxPGap, why: emptyBenchWhy(h, candidates, decision) }));
  const maxCovered = Math.max(0, ...selected.flatMap((s) => s.coveredCells.map((c) => c.pGap)));
  return {
    schemaVersion: STANDBY_SCHEMA_VERSION,
    asOfMs: nowMs,
    horizonEndMs,
    cells,
    hospitals,
    candidates,
    selected,
    totalEUM: round1(totalEUM),
    totalWeightedEUM: round1(totalWeightedEUM),
    expectedEUMAvoided: round1(avoided),
    residualEUM: round1(Math.max(0, totalWeightedEUM - avoided)),
    falseAlarmChance: selected.length === 0 ? null : round3(1 - maxCovered),
    emptyBenchHospitals: emptyBench,
    why: [
      `Grid: ${hospitals.length} hospitals x ${cells.length / Math.max(1, hospitals.length)} cells of ${STANDBY_CELL_MIN} min to ${etClock(horizonEndMs)} ET; P(gap) = max(existing HARD_GAP/DEADLOCK, supply vs block minimum with P(spike) from the surge forecast).`,
      `Expected uncovered minutes ${round1(totalEUM)} (stroke-weighted ${round1(totalWeightedEUM)}); ${selected.length} physician(s) selected avoid an expected ${round1(avoided)} weighted minutes; residual ${round1(Math.max(0, totalWeightedEUM - avoided))}.`,
      `Selection: greedy probabilistic coverage (submodular, (1 - 1/e) of the best set), each round maximizing covered P(gap) x 15 min x stroke weight x remaining risk x P(accept) / burden; stop under ${STANDBY_MIN_GAIN_EUM} EUM or at ${STANDBY_MAX_SELECTED}.`,
    ],
  };
}

/** Hospitals with any gap risk become HARD_GAP-shaped needs so the ledger's rules 2 and 6 see them as "the hospitals with the gap". */
function probabilisticNeeds(cells: readonly GapCell[], hospitals: readonly HospitalRisk[], horizonEndMs: EpochMs): Need[] {
  return hospitals
    .filter((h) => h.maxPGap > 0)
    .map((h) => {
      const risky = cells.filter((c) => c.hospitalId === h.hospitalId && c.pGap > 0 && c.coverableByOne);
      const startMs = risky[0]?.startMs ?? horizonEndMs;
      const endMs = (risky.at(-1)?.endMs ?? startMs) as EpochMs;
      return {
        id: `risk-${fnv1a(`${h.hospitalId}|${startMs}`)}`,
        kind: 'HARD_GAP' as const,
        hospitalId: h.hospitalId,
        hospitalName: h.hospitalName,
        startMs,
        endMs,
        severity: 'high' as const,
        strokeAtRisk: h.strokeWeight > (0.25 / 1.25) + 1e-9,
        consultIds: [],
        attentionItemIds: [],
        qualifiesForOffers: true,
        required: null,
        staffedConfirmed: null,
        staffedExpected: null,
        rule: 'NEED_HARD_GAP' as const,
        why: [`Gap risk at ${h.hospitalName}: max P(gap) ${h.maxPGap}, ${h.eum} expected uncovered minutes (standby grid).`],
        because: [],
      };
    });
}

function candidateOf(
  r: OffShiftPhysician,
  entry: LedgerEntry | undefined,
  cells: readonly GapCell[],
  weights: ReadonlyMap<string, number>,
  decision: DecisionReport,
  nowMs: EpochMs,
  horizonEndMs: EpochMs,
  input: StandbyPlanInput,
): StandbyCandidate {
  const credentials = decision.detection.staffing.credentials.get(r.physicianId) ?? new Set<string>();
  const booked = (input.acceptedOffers ?? []).filter((o) => o.physicianId === r.physicianId && o.endMs > nowMs);
  const bookedHours = booked.reduce((h, o) => h + (o.endMs - o.startMs) / HOUR, 0);
  const headroomMs = Math.max(0, (MAX_HOURS_7D - r.hoursWorkedLast7d - bookedHours) * HOUR);
  const window = windowOf(r, nowMs, horizonEndMs, headroomMs);
  const preAlertsTonight = input.history?.preAlertsTonight.get(r.physicianId) ?? 0;
  const alerts7d = input.history?.alerts7d.get(r.physicianId) ?? 0;
  const failedLedger = entry?.rules.find((x) => x.pass === false);
  let failingRule: StandbyCandidate['failingRule'] = null;
  if (failedLedger !== undefined) failingRule = { rule: failedLedger.rule, detail: failedLedger.detail };
  else if (entry === undefined) failingRule = { rule: 'ELIG_CREDENTIALED_AT_GAP', detail: 'not in the ledger' };
  else if (window.minutes < STANDBY_MIN_WINDOW_MIN) failingRule = { rule: 'STANDBY_WINDOW_2H', detail: `standby window ${etClock(window.startMs)}-${etClock(window.endMs)} ET is ${window.minutes} min < ${STANDBY_MIN_WINDOW_MIN} (brief: offers are at least 2 hours long)` };
  else if (STANDBY_ONE_PREALERT_PER_NIGHT && preAlertsTonight > 0) failingRule = { rule: 'STANDBY_ONE_PER_NIGHT', detail: `already pre-alerted ${preAlertsTonight}x tonight (fairness guard)` };
  const eligible = failingRule === null;
  const covered = eligible ? cells.filter((c) => credentials.has(c.hospitalId) && c.pGap > 0 && c.coverableByOne && window.startMs <= c.startMs && c.startMs < window.endMs) : [];
  const pAccept = STANDBY_ACCEPT_BASE / (1 + STANDBY_ACCEPT_DECLINE_PENALTY * r.offersDeclinedLast30d);
  const burden = 1 + STANDBY_BURDEN_DECLINE_WEIGHT * r.offersDeclinedLast30d;
  const value = covered.reduce((s, c) => s + c.pGap * STANDBY_CELL_MIN * (weights.get(c.hospitalId) ?? 1) * pAccept, 0);
  const coveredHospitals = [...new Set(covered.map((c) => c.hospitalId))].sort(compareIds);
  const reason = eligible
    ? `eligible: window ${etClock(window.startMs)}-${etClock(window.endMs)} ET (${window.minutes} min), covers ${covered.length} risk cell(s) at ${coveredHospitals.join(', ') || 'no credentialed hospital at risk'}; P(accept) ${round3(pAccept)} (${r.offersDeclinedLast30d} decline(s) in 30 d, illustrative), burden ${round3(burden)}`
    : `not eligible: ${failingRule?.rule}: ${failingRule?.detail}`;
  return {
    physicianId: r.physicianId,
    name: r.name,
    eligible,
    failingRule,
    window,
    minutesToOnline: r.estMinutesToOnline,
    coveredHospitals,
    coveredCells: covered.length,
    pAccept: round3(pAccept),
    burden: round3(burden),
    declined30d: r.offersDeclinedLast30d,
    valueEUM: round1(value),
    reason,
    preAlertsTonight,
    alerts7d,
  };
}

/** Window start = max(t + approval latency + time to online, rest-eligible at); end = min(next shift, 60-h headroom, horizon end). */
function windowOf(r: OffShiftPhysician, nowMs: EpochMs, horizonEndMs: EpochMs, headroomMs: number): StandbyWindow {
  const ready = nowMs + (STANDBY_APPROVAL_LATENCY_MIN + r.estMinutesToOnline) * MIN;
  const rested = r.lastShiftEnd + MIN_REST_HOURS * HOUR;
  const startMs = Math.max(ready, rested);
  const ends: { atMs: EpochMs; reason: StandbyWindow['endReason'] }[] = [
    { atMs: r.nextShiftStart, reason: 'next_shift' },
    { atMs: startMs + headroomMs, reason: 'hours_headroom' },
    { atMs: horizonEndMs, reason: 'horizon' },
  ];
  const end = ends.reduce((a, b) => (b.atMs < a.atMs ? b : a));
  const endMs = Math.max(startMs, end.atMs);
  return { startMs, endMs, minutes: Math.round((endMs - startMs) / MIN), startReason: rested > ready ? 'rest_10h' : 'approval_plus_online', endReason: end.reason };
}

/** Inputs the greedy needs from a candidate; exported so tests can brute-force small cases. */
export interface SelectableCandidate {
  readonly physicianId: string;
  readonly name: string;
  readonly eligible: boolean;
  readonly window: StandbyWindow | null;
  readonly pAccept: number;
  readonly burden: number;
  readonly declined30d: number;
  readonly covers: (cell: GapCell) => boolean;
}

export function selectable(c: StandbyCandidate, credentials: ReadonlySet<string>): SelectableCandidate {
  return {
    physicianId: c.physicianId,
    name: c.name,
    eligible: c.eligible,
    window: c.window,
    pAccept: c.pAccept,
    burden: c.burden,
    declined30d: c.declined30d,
    covers: (cell) => c.window !== null && credentials.has(cell.hospitalId) && cell.pGap > 0 && cell.coverableByOne && c.window.startMs <= cell.startMs && cell.startMs < c.window.endMs,
  };
}

/**
 * Greedy probabilistic coverage. R(cell) starts at 1; each round picks the
 * candidate maximizing sum_covered pGap * 15 * w * R * pAccept / burden, then
 * R *= (1 - pAccept) on the cells covered. Stops when the gain is under
 * STANDBY_MIN_GAIN_EUM or STANDBY_MAX_SELECTED are chosen. Ties: lower burden,
 * fewer declines, then id (physician fairness 4.5).
 */
export function greedySelect(cells: readonly GapCell[], weights: ReadonlyMap<string, number>, candidates: readonly StandbyCandidate[], credentialsOf?: (id: string) => ReadonlySet<string>): StandbySelection[] {
  const sel = candidates.map((c) => selectable(c, credentialsOf?.(c.physicianId) ?? new Set(c.coveredHospitals)));
  return greedySelectFrom(cells, weights, sel);
}

export function greedySelectFrom(cells: readonly GapCell[], weights: ReadonlyMap<string, number>, candidates: readonly SelectableCandidate[]): StandbySelection[] {
  const R = new Map<string, number>(cells.map((c) => [cellKey(c), 1]));
  const chosen: StandbySelection[] = [];
  const pool = candidates.filter((c) => c.eligible && c.window !== null);
  for (let round = 1; round <= STANDBY_MAX_SELECTED && pool.length > 0; round++) {
    let best: { c: SelectableCandidate; gain: number; score: number; covered: GapCell[] } | null = null;
    for (const c of pool) {
      const covered = cells.filter((cell) => c.covers(cell));
      const gain = covered.reduce((s, cell) => s + cell.pGap * STANDBY_CELL_MIN * (weights.get(cell.hospitalId) ?? 1) * (R.get(cellKey(cell)) ?? 1) * c.pAccept, 0);
      const score = gain / c.burden;
      if (
        best === null ||
        score > best.score + 1e-9 ||
        (Math.abs(score - best.score) <= 1e-9 && (c.burden < best.c.burden || (c.burden === best.c.burden && (c.declined30d < best.c.declined30d || (c.declined30d === best.c.declined30d && compareIds(c.physicianId, best.c.physicianId) < 0)))))
      ) {
        best = { c, gain, score, covered };
      }
    }
    if (best === null || best.gain < STANDBY_MIN_GAIN_EUM) break;
    for (const cell of best.covered) R.set(cellKey(cell), (R.get(cellKey(cell)) ?? 1) * (1 - best.c.pAccept));
    const w = best.c.window as StandbyWindow;
    const maxP = Math.max(0, ...best.covered.map((x) => x.pGap));
    chosen.push({
      physicianId: best.c.physicianId,
      name: best.c.name,
      round,
      window: w,
      coveredHospitals: [...new Set(best.covered.map((x) => x.hospitalId))].sort(compareIds),
      coveredCells: best.covered.map((x) => ({ hospitalId: x.hospitalId, startMs: x.startMs, pGap: x.pGap })),
      pAccept: best.c.pAccept,
      valueEUM: round1(best.gain),
      falseAlarmChance: round3(1 - maxP),
      why: [
        `Round ${round}: covers ${best.covered.length} risk cell(s) at ${[...new Set(best.covered.map((x) => x.hospitalId))].sort(compareIds).join(', ')} within ${etClock(w.startMs)}-${etClock(w.endMs)} ET.`,
        `Expected weighted uncovered minutes avoided ${round1(best.gain)} = sum of P(gap) x 15 x stroke weight x remaining risk x P(accept ${best.c.pAccept}); ranked by that over burden ${best.c.burden}.`,
        `False-alarm chance about ${round3(1 - maxP)} (1 - max covered P(gap); approximation).`,
      ],
    });
    pool.splice(pool.indexOf(best.c), 1);
  }
  return chosen;
}

/** Expected weighted uncovered minutes avoided by a SET of candidates: sum over cells of pGap * 15 * w * (1 - prod(1 - pAccept)). Used by the brute-force test. */
export function setValue(cells: readonly GapCell[], weights: ReadonlyMap<string, number>, set: readonly SelectableCandidate[]): number {
  let total = 0;
  for (const cell of cells) {
    let miss = 1;
    for (const c of set) if (c.covers(cell)) miss *= 1 - c.pAccept;
    total += cell.pGap * STANDBY_CELL_MIN * (weights.get(cell.hospitalId) ?? 1) * (1 - miss);
  }
  return total;
}

export const cellKey = (c: { hospitalId: string; startMs: EpochMs }): string => `${c.hospitalId}|${c.startMs}`;

function emptyBenchWhy(h: HospitalRisk, candidates: readonly StandbyCandidate[], decision: DecisionReport): string {
  const credentialed = candidates.filter((c) => decision.detection.staffing.credentials.get(c.physicianId)?.has(h.hospitalId) ?? false);
  if (credentialed.length === 0) return `no off-shift physician is credentialed at ${h.hospitalName} (credentialing gap, strategic)`;
  const eligible = credentialed.filter((c) => c.eligible);
  if (eligible.length === 0) return `credentialed off-shift physicians all fail a rule: ${credentialed.map((c) => `${c.physicianId} ${c.failingRule?.rule ?? ''}`).join('; ')}`;
  return `eligible candidates exist (${eligible.map((c) => c.physicianId).join(', ')}) but the expected gain fell under ${STANDBY_MIN_GAIN_EUM} EUM or ${STANDBY_MAX_SELECTED} were already selected`;
}
