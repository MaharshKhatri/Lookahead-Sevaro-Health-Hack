import { DateTime } from 'luxon';
import { assertNoPHI } from '../decide/phi';
import { ET_ZONE } from '../time';
import type { EpochMs } from '../types';

/**
 * Standby messages (brief "Notification and Safety Constraints": "No patient
 * information in any notification. Hospital names, hours and start time
 * only."). Each text is checked with assertNoPHI in strict whitelist mode
 * before it leaves the engine. The pre-alert says "(no case information)"
 * rather than the Phase 4 note's "(no patient information)" because the
 * engine's PHI denylist refuses the word "patient" in any outbound text.
 */

export const STANDBY_MESSAGE_VOCABULARY: ReadonlySet<string> = new Set(
  'lookahead standby request no case information possible coverage need et at if needed we would ask you to log on within min reply i can be ready not tonight please by cover until thank the for is released action'.split(' '),
);

const hm = (ms: EpochMs) => DateTime.fromMillis(ms, { zone: ET_ZONE }).toFormat('HH:mm');

export function preAlertMessage(x: { readonly hospitalNames: readonly string[]; readonly startMs: EpochMs; readonly endMs: EpochMs; readonly minutesToOnline: number }): string {
  const text = `Lookahead standby request (no case information): possible coverage need ${hm(x.startMs)}–${hm(x.endMs)} ET at ${x.hospitalNames.join(', ')}. If needed we would ask you to log on within ${x.minutesToOnline} min. Reply: I can be ready / Not tonight.`;
  assertNoPHI(text, { allowedWords: STANDBY_MESSAGE_VOCABULARY, allowedPhrases: x.hospitalNames });
  return text;
}

export function activationMessage(x: { readonly hospitalNames: readonly string[]; readonly logOnByMs: EpochMs; readonly endMs: EpochMs }): string {
  const text = `Please log on by ${hm(x.logOnByMs)} ET to cover ${x.hospitalNames.join(', ')} until ${hm(x.endMs)} ET.`;
  assertNoPHI(text, { allowedWords: STANDBY_MESSAGE_VOCABULARY, allowedPhrases: x.hospitalNames });
  return text;
}

export function releaseMessage(x: { readonly startMs: EpochMs; readonly endMs: EpochMs }): string {
  const text = `Thank you. The standby for ${hm(x.startMs)}–${hm(x.endMs)} ET is released. No action needed.`;
  assertNoPHI(text, { allowedWords: STANDBY_MESSAGE_VOCABULARY });
  return text;
}
