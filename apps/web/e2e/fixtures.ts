import { readFileSync } from 'node:fs';

/** Expected answers come from the engine's golden fixtures (CLAUDE.md rule 5), never from app code. */
const golden = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../../../packages/engine/test/golden/${file}`, import.meta.url), 'utf8')) as T;

export const TOP_ATTENTION = golden<{ id: string; headline: string; severity: string }[]>('attention_top5_1820.json')[0];
export const ELIGIBILITY = golden<{ physicianId: string; eligible: boolean }[]>('eligibility_1820.json');
export const NAIVE_DIFFS = golden<unknown[]>('naive_diffs_1820.json');

/** Browser-context options for a second device (phone, other tab) on the same server. */
export const device = (baseURL: string | undefined, viewport: { width: number; height: number }, mobile = false) => ({
  ...(baseURL === undefined ? {} : { baseURL }),
  viewport,
  ...(mobile ? { isMobile: true, hasTouch: true } : {}),
});
