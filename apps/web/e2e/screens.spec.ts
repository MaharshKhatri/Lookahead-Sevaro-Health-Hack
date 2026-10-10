import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { device } from './fixtures';

/**
 * Design review screenshots into docs/screens/ (Session 6): every page at
 * 1920x1080, the phone flows at 390x844. Walks the real demo path so each
 * shot shows live engine output.
 */
const OUT = fileURLToPath(new URL('../../../docs/screens/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const DESK = { width: 1920, height: 1080 };
const PHONE = { width: 390, height: 844 };

const shot = async (page: Page, name: string, fullPage = false) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage });
};

test('screenshots of every page', async ({ page, browser, baseURL, request }) => {
  test.setTimeout(120_000);
  await request.post('/api/demo/reset');
  await page.setViewportSize(DESK);
  await page.goto('/');
  await expect(page.getByTestId('attention-top')).toBeVisible();
  await shot(page, '01-command-center');
  await page.getByTestId('tab-trap').click();
  await shot(page, '02-command-center-trap');
  await page.getByTestId('tab-whatif').click();
  await shot(page, '03-command-center-whatif');

  await page.getByTestId('propose-offer').click();
  const card = page.getByTestId('offer-card').first();
  await expect(card.getByTestId('offer-status')).toHaveText('PROPOSED');
  const offerId = (await card.getAttribute('data-offer-id')) ?? '';

  const phoneCtx = await browser.newContext(device(baseURL, PHONE, true));
  const phone = await phoneCtx.newPage();
  await phone.goto('/lead');
  await expect(phone.getByTestId('lead-offer')).toBeVisible();
  await shot(phone, '04-lead-inbox-390');
  await shot(phone, '04b-lead-inbox-390-full', true);
  await phone.getByTestId('lead-approve').click();
  await expect(phone.getByTestId('lead-empty')).toBeVisible();

  await expect(card.getByTestId('offer-status')).toHaveText('DELIVERED');
  await shot(page, '05-command-center-offer-delivered');

  await phone.goto(`/offer/${offerId}`);
  await expect(phone.getByTestId('phone-countdown')).toBeVisible();
  await shot(phone, '06-offer-phone-390');
  await phone.getByTestId('offer-accept').click();
  await expect(phone.getByTestId('phone-status')).toHaveText('ACCEPTED');
  await shot(phone, '07-offer-accepted-phone-390');

  await expect(card.getByTestId('offer-status')).toHaveText('ACCEPTED');
  await page.getByTestId('tab-whatif').click();
  await shot(page, '08-command-center-accepted-whatif');

  await page.goto(`/audit/${offerId}`);
  await expect(page.getByTestId('audit-physician').first()).toBeVisible();
  await shot(page, '09-audit');

  await page.goto('/state');
  await expect(page.getByTestId('physician-row').first()).toBeVisible();
  await shot(page, '10-state');

  await page.goto('/integrity');
  await expect(page.getByTestId('integrity-correct')).toBeVisible();
  await shot(page, '11-integrity');
  await page.getByTestId('integrity-slider').scrollIntoViewIfNeeded();
  await page.getByTestId('slider-input').fill('10');
  await shot(page, '12-integrity-slider-1815');

  await page.goto('/inject');
  await page.getByTestId('inject-sample').click();
  await page.getByTestId('inject-submit').click();
  await expect(page.getByTestId('inject-result')).toContainText('ACCEPTED');
  await shot(page, '13-inject');
  await page.goto('/');
  await expect(page.getByTestId('attention-top')).toBeVisible();
  await shot(page, '14-command-center-after-inject');
  await phoneCtx.close();
});
