/**
 * Clinical impact constants (final polish sprint, D-97). LOOKAHEAD-DEFINED
 * (illustrative): the brief has no clinical outcome model. Source for the
 * three per-minute rates: Saver JL, "Time Is Brain—Quantified," Stroke
 * 2006;37:263–266, which estimates losses for a typical large-vessel acute
 * ischemic stroke per minute of untreated time. Lookahead applies them only
 * as an extrapolation: unassigned consult minutes are assumed to pass 1:1
 * into treatment delay (stated on every page that shows them). Never a
 * clinical outcome measurement; never a decision input.
 */

export const CLINICAL_SOURCE_CITATION = 'Saver JL. Time Is Brain—Quantified. Stroke. 2006;37:263–266.';

/** LOOKAHEAD-DEFINED (illustrative), Saver 2006: neurons lost per minute in a typical large-vessel acute ischemic stroke. */
export const NEURONS_LOST_PER_MIN = 1_900_000;
/** LOOKAHEAD-DEFINED (illustrative), Saver 2006: synapses lost per minute. */
export const SYNAPSES_LOST_PER_MIN = 14_000_000_000;
/** LOOKAHEAD-DEFINED (illustrative), Saver 2006: accelerated brain aging per minute, in WEEKS (3.1 weeks per minute). */
export const BRAIN_AGING_WEEKS_PER_MIN = 3.1;
/** LOOKAHEAD-DEFINED (illustrative): unassigned minutes are assumed to pass 1:1 into treatment delay. */
export const DELAY_PASS_THROUGH_RATIO = 1;

/** LOOKAHEAD-DEFINED (illustrative): patient clock severity. Critical above this many unassigned minutes (or when no credentialed physician is routable). */
export const PATIENT_CLOCK_CRITICAL_MIN = 10;
/** LOOKAHEAD-DEFINED (illustrative): patient clock severity. Warning above this many unassigned minutes. */
export const PATIENT_CLOCK_WARNING_MIN = 5;
