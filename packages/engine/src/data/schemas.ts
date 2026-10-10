import { z } from 'zod';
import { CONSULT_STAGES, CONSULT_TYPES, EVENT_TYPES, SELF_REPORTED_STATUSES } from '../types';
import {
  clockTime,
  decimal,
  ianaZone,
  instant,
  integer,
  oneOf,
  optionalText,
  requiredText,
  text,
  timeBlock,
  yFlag,
  yesNo,
} from './fields';

/**
 * One zod schema per CSV. Keys are the exact column headers of the Sevaro
 * files, in file order (CLAUDE.md rule 2). The expected header list for each
 * file is derived from these keys.
 */

/** Brief "Event types": an event_type outside this list is a hard error, never guessed. */
export const eventStreamSchema = z.object({
  event_id: requiredText,
  event_time: instant,
  ingested_at: instant,
  consult_id: optionalText,
  event_type: oneOf(EVENT_TYPES),
  physician_id: optionalText,
  hospital_id: optionalText,
  description: text,
});

export const hospitalsSchema = z.object({
  hospital_id: requiredText,
  hospital_name: requiredText,
  local_timezone: ianaZone,
  coverage_tier: requiredText,
});

export const physiciansOnShiftSchema = z.object({
  physician_id: requiredText,
  name: requiredText,
  shift_start_et: clockTime,
  shift_end_et: clockTime,
  split_shift_opt_in: text,
});

export const offShiftRosterSchema = z.object({
  physician_id: requiredText,
  name: requiredText,
  role: requiredText,
  split_shift_opt_in: yesNo,
  last_shift_end: instant,
  next_shift_start: instant,
  hours_worked_last_7d: decimal,
  est_minutes_to_online: integer,
  preferred_channel: requiredText,
  offers_declined_last_30d: integer,
});

/** Fixed leading columns of credentialing_matrix.csv; every other column is a hospital ID. */
export const credentialingFixedSchema = z.object({
  physician_id: requiredText,
  name: requiredText,
});

/** Full credentialing schema for a given header: fixed columns plus one Y/blank flag per hospital column. */
export function credentialingSchema(hospitalColumns: readonly string[]) {
  const flags: Record<string, typeof yFlag> = {};
  for (const h of hospitalColumns) flags[h] = yFlag;
  return credentialingFixedSchema.extend(flags);
}

export const baselineHourlySchema = z.object({
  hospital_id: requiredText,
  hospital_name: requiredText,
  dow_type: requiredText,
  hour_start_et: clockTime,
  mean_consults: decimal,
  p90_consults: decimal,
  weeks_sampled: integer,
});

export const coverageRequirementsSchema = z.object({
  hospital_id: requiredText,
  hospital_name: requiredText,
  time_block_et: timeBlock,
  min_available_credentialed_physicians: integer,
});

export const snapshotPhysiciansSchema = z.object({
  physician_id: requiredText,
  name: requiredText,
  shift_et: timeBlock,
  self_reported_status: oneOf(SELF_REPORTED_STATUSES),
  desktop_agent: requiredText,
  derived_state: requiredText,
  consults_this_shift: integer,
  calls_this_shift: integer,
  open_consults: integer,
  minutes_to_shift_end: integer,
});

export const snapshotOpenConsultsSchema = z.object({
  consult_id: requiredText,
  hospital_id: requiredText,
  hospital_name: requiredText,
  physician_id: requiredText,
  consult_type: oneOf(CONSULT_TYPES),
  current_stage: oneOf(CONSULT_STAGES),
  stage_entered_at: clockTime,
  minutes_in_stage: integer,
  minutes_since_received: integer,
});

export const columnsOf = (schema: z.AnyZodObject): readonly string[] => Object.keys(schema.shape);
