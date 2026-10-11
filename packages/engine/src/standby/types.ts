import type { RuleCode } from '../replay/rules';
import type { EpochMs } from '../types';

/**
 * Standby Neurologist Network (Phase 4): pre-position eligible off-shift
 * physicians BEFORE a forecast surge. Pre-alert -> "I can be ready" ->
 * activation when risk crosses a threshold -> online in time, or released if
 * risk fades. Reuses the brief's eligibility rules, roles, 10-min expiry, PHI
 * guard and audit (brief "Users and Decision Rights", "Notification and
 * Safety Constraints"); all thresholds are LOOKAHEAD-DEFINED (policy.ts).
 */

export interface GapCell {
  readonly hospitalId: string;
  readonly hospitalName: string;
  /** Cell start (15-min slot [startMs, startMs + 15 min)). */
  readonly startMs: EpochMs;
  readonly endMs: EpochMs;
  /** Existing projection numbers at the cell (OQ-24(a)): supply = confirmed + expected. */
  readonly supply: number;
  readonly staffedConfirmed: number;
  readonly staffedExpected: number;
  readonly requiredBase: number;
  /** The existing coverage class at the cell, upgraded to DEADLOCK while a DEADLOCK_NOW need overlaps it. */
  readonly existingClass: 'OK' | 'AT_RISK' | 'HARD_GAP' | 'DEADLOCK';
  /** 1 when the existing class is HARD_GAP or DEADLOCK. */
  readonly pDeterministic: number;
  /** 1 if supply < requiredBase; P(spike) if supply == requiredBase; else 0. */
  readonly pProbabilistic: number;
  readonly pSpike: number;
  /** max(pDeterministic, pProbabilistic). */
  readonly pGap: number;
  /** Whether one extra credentialed physician would meet the requirement in this cell. */
  readonly coverableByOne: boolean;
  readonly rule: RuleCode;
}

export interface HospitalRisk {
  readonly hospitalId: string;
  readonly hospitalName: string;
  /** Expected uncovered minutes = sum of pGap * 15 over the cells (unweighted). */
  readonly eum: number;
  /** Stroke weighting w_h = (stroke share + 0.25) / 1.25. */
  readonly strokeWeight: number;
  readonly weightedEum: number;
  readonly maxPGap: number;
  readonly firstRiskMs: EpochMs | null;
}

export interface StandbyWindow {
  readonly startMs: EpochMs;
  readonly endMs: EpochMs;
  readonly minutes: number;
  /** Why the window starts/ends where it does. */
  readonly startReason: 'approval_plus_online' | 'rest_10h';
  readonly endReason: 'next_shift' | 'hours_headroom' | 'horizon';
}

export interface StandbyCandidate {
  readonly physicianId: string;
  readonly name: string;
  readonly eligible: boolean;
  /** First failing rule (ledger rule code or STANDBY_WINDOW_2H), with detail. */
  readonly failingRule: { readonly rule: string; readonly detail: string } | null;
  readonly window: StandbyWindow | null;
  readonly minutesToOnline: number;
  readonly coveredHospitals: readonly string[];
  readonly coveredCells: number;
  readonly pAccept: number;
  readonly burden: number;
  readonly declined30d: number;
  /** Expected weighted uncovered minutes avoided if asked now (sum of pGap * 15 * w * R * pAccept over covered cells). */
  readonly valueEUM: number;
  readonly reason: string;
  /** Standby pre-alerts already sent to this physician tonight (fairness guard). */
  readonly preAlertsTonight: number;
  /** Pre-alerts plus offers in the trailing 7 days from our own log. */
  readonly alerts7d: number;
}

export interface StandbySelection {
  readonly physicianId: string;
  readonly name: string;
  readonly round: number;
  readonly window: StandbyWindow;
  readonly coveredHospitals: readonly string[];
  readonly coveredCells: readonly { readonly hospitalId: string; readonly startMs: EpochMs; readonly pGap: number }[];
  readonly pAccept: number;
  readonly valueEUM: number;
  /** 1 - max covered pGap: labelled approximation of "called in for nothing". */
  readonly falseAlarmChance: number;
  readonly why: readonly string[];
}

export interface StandbyPlan {
  readonly schemaVersion: string;
  readonly asOfMs: EpochMs;
  readonly horizonEndMs: EpochMs;
  readonly cells: readonly GapCell[];
  readonly hospitals: readonly HospitalRisk[];
  readonly candidates: readonly StandbyCandidate[];
  readonly selected: readonly StandbySelection[];
  readonly totalEUM: number;
  readonly totalWeightedEUM: number;
  readonly expectedEUMAvoided: number;
  readonly residualEUM: number;
  readonly falseAlarmChance: number | null;
  /** Hospitals with max P(gap) >= STANDBY_EMPTY_BENCH_PGAP that no selected physician covers. */
  readonly emptyBenchHospitals: readonly { readonly hospitalId: string; readonly hospitalName: string; readonly maxPGap: number; readonly why: string }[];
  readonly why: readonly string[];
}
