import 'server-only';
import * as engine from '@lookahead/engine';
import type { PolicyEntryDTO } from '@/lib/dto';

/**
 * Read-only Policy panel catalog (Phase 7). Lists every exported constant of
 * packages/engine/src/policy.ts whose name starts with FORECAST_, HAWKES_,
 * STROKE_SHARE_, STANDBY_ or REWIND_, plus the brief-defined limits reachable
 * from the engine's public surface. Values are read from the engine at
 * request time (never typed here); the labels repeat the doc comments'
 * wording so each entry says whether the brief fixed it or Lookahead chose it.
 */

const PREFIXES = ['FORECAST_', 'HAWKES_', 'STROKE_SHARE_', 'STANDBY_', 'REWIND_'] as const;

/** Doc-comment wording per constant (policy.ts). Anything not listed gets the section's generic label. */
const NOTES: Readonly<Record<string, { readonly source: PolicyEntryDTO['source']; readonly note: string }>> = {
  FORECAST_SCHEMA_VERSION: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'forecast output schema version.' },
  FORECAST_DAY_RATE_PRIOR_A: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'prior weight A of the network day-rate multiplier m_net = (A + N_net) / (A + Lambda0_net): ~20 expected consults of prior.' },
  FORECAST_HOSPITAL_PRIOR_B: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'per-hospital Gamma prior weight B (shape B*m_net, rate B): ~6 expected consults of prior per hospital.' },
  FORECAST_DAY_RATE_LAG_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'the last 60 min of arrivals belong to the self-excitation term, not the day-rate estimate (matches the brief\'s trailing-60 spike window).' },
  HAWKES_ETA_GRID: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'Hawkes branching-ratio grid eta in {0, 0.05, ..., 0.60}; ties go to the smaller eta.' },
  HAWKES_HALF_LIFE_GRID_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'Hawkes kernel half-life grid in minutes; ties go to the shorter half-life.' },
  FORECAST_INTENSITY_FLOOR: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'intensity floor inside the log-likelihood so an arrival in an hour with zero baseline is not -infinity.' },
  FORECAST_N_MAX: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'count PMFs are truncated at this count and renormalized; the dropped tail must stay below FORECAST_TAIL_TOLERANCE.' },
  FORECAST_TAIL_TOLERANCE: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'largest tolerated truncated tail mass.' },
  FORECAST_HORIZONS_MIN: { source: 'BRIEF (Detect: "next 60-90 minutes") + LOOKAHEAD-DEFINED (illustrative)', note: 'forecast horizons in minutes; the brief asks for 60-90, Lookahead extends to 120.' },
  FORECAST_CHECKPOINT_STEP_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'spike-probability checkpoints every 15 min out to +180 (the standby planning horizon).' },
  FORECAST_CHECKPOINT_HORIZON_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'spike-probability checkpoint horizon (the standby planning horizon).' },
  STROKE_SHARE_PRIOR_WEIGHT: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'Beta prior weight on the network stroke share when thinning a hospital\'s forecast to stroke consults.' },
  FORECAST_RISK_RANK_WINDOW_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'risk rank looks at the maximum spike probability within this many minutes, then the 60-min expectation.' },
  STANDBY_HORIZON_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'planning horizon of the gap-probability grid.' },
  STANDBY_CELL_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'cell size of the gap-probability grid.' },
  STANDBY_APPROVAL_LATENCY_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'minutes from proposal to a sent pre-alert (lead approval), added before time-to-online when sizing a standby window.' },
  STANDBY_MIN_WINDOW_MIN: { source: 'BRIEF (eligibility rule 6: "Offers are at least 2 hours long")', note: 'a standby window must be at least this long.' },
  STANDBY_STROKE_WEIGHT_FLOOR: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'stroke weighting of a hospital\'s uncovered minutes, w = (stroke share + 0.25) / 1.25, so a hospital with no stroke history still counts 20 %.' },
  STANDBY_ACCEPT_BASE: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'acceptance estimate pAccept = 0.8 / (1 + 0.25 * declined_30d); the roster\'s decline count is the only signal we have.' },
  STANDBY_ACCEPT_DECLINE_PENALTY: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'decline penalty in the acceptance estimate.' },
  STANDBY_BURDEN_DECLINE_WEIGHT: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'burden = 1 + 0.2 * declined_30d (physician-fairness: ask the often-asked less).' },
  STANDBY_MIN_GAIN_EUM: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'greedy selection stops when the next physician adds under this many expected uncovered minutes.' },
  STANDBY_MAX_SELECTED: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'greedy selection stops at this many physicians.' },
  STANDBY_ACTIVATE_PGAP: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'activation is recommended when a covered cell has P(gap) >= 0.6 and starts within time-to-online + 15 min, or a covered hospital is deadlocked now.' },
  STANDBY_ACTIVATE_LEAD_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'lead time added to time-to-online when testing the activation trigger.' },
  STANDBY_RELEASE_PGAP: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'stand-down is recommended when no covered remaining cell has P(gap) >= 0.2 at two consecutive 5-min evaluations (hysteresis, OQ-51).' },
  STANDBY_RECOMPUTE_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'recompute step of the stand-down hysteresis.' },
  STANDBY_EMPTY_BENCH_PGAP: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'a hospital with max P(gap) at or above this and nobody selected to cover it is an "empty bench".' },
  STANDBY_COUNTS_AS_OFFER: { source: 'OQ-48 (default)', note: 'an open standby counts as the physician\'s one open offer, and a sent pre-alert counts toward 3 offers per week (conservative).' },
  STANDBY_ONE_PREALERT_PER_NIGHT: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'never pre-alert the same physician twice in one night (fairness guard).' },
  STANDBY_SCHEMA_VERSION: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'standby plan schema version.' },
  REWIND_START_SECOND_OF_DAY_ET: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'the rewind replays the day as if Lookahead had been running from this ET wall-clock time (seconds of day).' },
  REWIND_STEP_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'rewind origin step in minutes.' },
  REWIND_LATENCY_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'human latencies assumed in the counterfactual, displayed on /rewind.' },
  REWIND_EVAL_HORIZON_MIN: { source: 'LOOKAHEAD-DEFINED (illustrative)', note: 'unassigned stroke minutes are counted up to the reference instant plus this horizon.' },
};

const SECTION: Readonly<Record<(typeof PREFIXES)[number], string>> = {
  FORECAST_: 'Surge forecast',
  HAWKES_: 'Surge forecast',
  STROKE_SHARE_: 'Surge forecast',
  STANDBY_: 'Standby network',
  REWIND_: 'Rewind',
};

const show = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

let cached: PolicyEntryDTO[] | null = null;

export function policyCatalog(): PolicyEntryDTO[] {
  if (cached !== null) return cached;
  const out: PolicyEntryDTO[] = [];
  // Brief-defined limits reachable from the engine's public surface (the rest of the brief's numbers appear in the LEDGER chips with their values).
  out.push({ section: 'Brief limits', name: 'OFFER_EXPIRY_MINUTES', value: String(engine.expiresAt(0) / 60_000), source: 'BRIEF ("Offers expire if not answered within 10 minutes")', note: 'applies to split-shift offers, standby pre-alerts and activation requests alike.' });
  out.push({ section: 'Brief limits', name: 'MIN_OFFER_MINUTES', value: String(engine.STANDBY_MIN_WINDOW_MIN), source: 'BRIEF (eligibility rule 6: "Offers are at least 2 hours long")', note: 'the minimum split-shift and standby window.' });
  out.push({ section: 'Brief limits', name: 'MAX_OFFER_HOURS', value: String(engine.MAX_OFFER_HOURS), source: 'OQ (default)', note: 'the longest split-shift window Lookahead offers ("a few hours").' });
  out.push({ section: 'Brief limits', name: 'MIN_PROJECTION_HORIZON_MIN', value: String(engine.MIN_PROJECTION_HORIZON_MIN), source: 'BRIEF ("Project coverage forward at least 90 minutes")', note: 'the detection projection runs to 120 (PROJECTION_HORIZON_MIN) and the decision projection to 300 (OQ-31).' });
  out.push({ section: 'Brief limits', name: 'CALL_COOLDOWN_MS', value: String(engine.CALL_COOLDOWN_MS), source: 'BRIEF (routing rule 4: 2-minute cooldown after a call)', note: 'milliseconds.' });
  out.push({ section: 'Brief limits', name: 'LOW_VOLUME_MAX_CONSULTS', value: show(engine.LOW_VOLUME_MAX_CONSULTS), source: 'BRIEF (routing rule 3: low-volume tiers, day 6 / night 4)', note: 'consults this shift above which a physician leaves the low-volume tier.' });
  out.push({ section: 'Brief limits', name: 'DECISION_RIGHTS', value: show(engine.DECISION_RIGHTS), source: 'BRIEF ("Users and Decision Rights")', note: 'who proposes, approves and accepts each intervention; standby commands reuse SPLIT_SHIFT_OFFER.' });
  const e = engine as unknown as Record<string, unknown>;
  for (const name of Object.keys(e).sort()) {
    const prefix = PREFIXES.find((p) => name.startsWith(p));
    if (prefix === undefined || typeof e[name] === 'function') continue;
    const n = NOTES[name];
    out.push({ section: SECTION[prefix], name, value: show(e[name]), source: n?.source ?? 'LOOKAHEAD-DEFINED (illustrative)', note: n?.note ?? 'see packages/engine/src/policy.ts.' });
  }
  cached = out;
  return out;
}
