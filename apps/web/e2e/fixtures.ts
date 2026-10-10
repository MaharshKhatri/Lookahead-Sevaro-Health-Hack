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

/** The clinical lead's PIN (OQ-44): the local server runs with LEAD_PIN=2026; remote runs pass E2E_LEAD_PIN. */
export const LEAD_PIN = process.env.E2E_LEAD_PIN ?? '2026';

type Page = import('@playwright/test').Page;

/** /lead on a phone-sized page: enter the PIN (the cookie then holds a MAC, not the PIN). */
export async function openLead(lead: Page): Promise<void> {
  await lead.goto('/lead');
  await lead.getByTestId('lead-pin').fill(LEAD_PIN);
  await lead.getByTestId('lead-pin-submit').click();
  await lead.getByTestId('lead-pin').waitFor({ state: 'detached' });
}

/** The tokenized physician link shown under the QR (OQ-44: /offer/<id>?t=<HMAC>). */
export async function offerLink(card: import('@playwright/test').Locator): Promise<string> {
  const url = (await card.getByTestId('offer-url').textContent()) ?? '';
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
