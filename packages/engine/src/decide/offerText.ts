import { DateTime } from 'luxon';
import { ET_ZONE } from '../time';
import type { EpochMs } from '../types';
import { OFFER_EXPIRY_MINUTES } from './brief-rules';
import { assertNoPHI } from './phi';

/**
 * Offer message: brief "Notification and Safety Constraints" ("Hospital names,
 * hours and start time only") and "Users and Decision Rights" (the physician
 * needs "a clear offer: hospitals, hours, start time, why they were asked").
 * The reason is generic; no consult ids, patient details or clinical terms.
 */

/** Every word the template may produce, besides hospital names. */
export const OFFER_MESSAGE_VOCABULARY: ReadonlySet<string> = new Set(
  'split-shift offer from the operations team hospitals start et on hours until reason projected coverage gap reply accept or decline this expires in minutes mon tue wed thu fri sat sun'.split(' '),
);

export interface OfferMessageInput {
  readonly hospitalNames: readonly string[];
  readonly startMs: EpochMs;
  readonly endMs: EpochMs;
}

export function draftOfferMessage(offer: OfferMessageInput): string {
  const start = DateTime.fromMillis(offer.startMs, { zone: ET_ZONE });
  const end = DateTime.fromMillis(offer.endMs, { zone: ET_ZONE });
  const hours = Math.round(((offer.endMs - offer.startMs) / 3_600_000) * 10) / 10;
  const text = [
    'Split-shift offer from the operations team.',
    `Hospitals: ${offer.hospitalNames.join(', ')}.`,
    `Start: ${start.toFormat('HH:mm')} ET on ${start.toFormat('ccc yyyy-MM-dd')}. Hours: ${hours} (until ${end.toFormat('HH:mm')} ET).`,
    'Reason: projected coverage gap.',
    `Reply ACCEPT or DECLINE. This offer expires in ${OFFER_EXPIRY_MINUTES} minutes.`,
  ].join('\n');
  assertNoPHI(text, { allowedWords: OFFER_MESSAGE_VOCABULARY, allowedPhrases: offer.hospitalNames });
  return text;
}
