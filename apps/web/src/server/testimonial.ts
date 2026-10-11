import 'server-only';

/**
 * Testimonial slot (sprint B2, D-97): rendered only when BOTH
 * TESTIMONIAL_QUOTE and TESTIMONIAL_ATTRIBUTION are set, read at request time
 * (no rebuild). Unset: null, and the page renders nothing at all; Lookahead
 * never ships placeholder or invented quotes.
 */
export interface Testimonial {
  readonly quote: string;
  readonly attribution: string;
}

export function testimonial(env: Readonly<Record<string, string | undefined>> = process.env): Testimonial | null {
  const quote = env.TESTIMONIAL_QUOTE?.trim() ?? '';
  const attribution = env.TESTIMONIAL_ATTRIBUTION?.trim() ?? '';
  return quote === '' || attribution === '' ? null : { quote, attribution };
}
