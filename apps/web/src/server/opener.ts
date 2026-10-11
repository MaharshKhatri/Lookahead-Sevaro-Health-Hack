import 'server-only';
import * as engine from '@lookahead/engine';
import { rewindFor } from './rewind';
import type { StoreSnapshot } from './store';

/**
 * /opener and /?opener=1 (final polish sprint A1/A3, LOOKAHEAD-DEFINED): the
 * single most impactful stroke episode of the rewind plus the clinical impact
 * extrapolation. Glue only: the rewind report is the memoized one served on
 * /rewind (rewindFor), and openerSummary / impactSummary read it without
 * recomputing anything. Null opener / not-ready rewind => honest empty state.
 */

export interface ClinicalConstantsDTO {
  readonly citation: string;
  readonly neuronsPerMin: number;
  readonly synapsesPerMin: number;
  readonly agingWeeksPerMin: number;
  readonly passThroughRatio: number;
}

export interface OpenerPageDTO {
  /** false when the engine rewind export is not available (nothing is shown rather than a guess). */
  readonly ready: boolean;
  readonly opener: engine.OpenerSummary | null;
  readonly impact: engine.ImpactSummary | null;
  readonly assumptions: engine.RewindReport['assumptions'] | null;
  readonly clinical: ClinicalConstantsDTO;
}

/** The Saver 2006 constants exactly as the engine uses them (clinical/constants.ts). */
export function clinicalConstants(): ClinicalConstantsDTO {
  return {
    citation: engine.CLINICAL_SOURCE_CITATION,
    neuronsPerMin: engine.NEURONS_LOST_PER_MIN,
    synapsesPerMin: engine.SYNAPSES_LOST_PER_MIN,
    agingWeeksPerMin: engine.BRAIN_AGING_WEEKS_PER_MIN,
    passThroughRatio: engine.DELAY_PASS_THROUGH_RATIO,
  };
}

/** The rewind DTO is the engine report spread with hospital names (server/rewind.ts), so it carries every RewindReport field. */
function asReport(dto: NonNullable<ReturnType<typeof rewindFor>>): engine.RewindReport {
  return dto as unknown as engine.RewindReport;
}

export function openerFor(s: StoreSnapshot): OpenerPageDTO {
  const clinical = clinicalConstants();
  const dto = rewindFor(s);
  if (dto === null) return { ready: false, opener: null, impact: null, assumptions: null, clinical };
  const report = asReport(dto);
  return {
    ready: true,
    opener: engine.openerSummary(report, s.dataset),
    impact: engine.impactSummary(report),
    assumptions: report.assumptions,
    clinical,
  };
}
