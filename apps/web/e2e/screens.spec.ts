import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { LEAD_PIN, device, offerLink } from './fixtures';

/**
 * Design review screenshots into docs/screens/ (Session 6): every page at
 * 1920x1080, the phone flows at 390x844. Walks the real demo path so each
 * shot shows live engine output. Session 7 adds the lead PIN, the Explain
 * briefing and the dataset admin page.
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
  await page.getByTestId('attention-top').getByTestId('explain-attention').click();
  await expect(page.getByTestId('narration-attention')).toBeVisible();
  await shot(page, '01b-command-center-explain');
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
  await expect(phone.getByTestId('lead-pin')).toBeVisible();
  await shot(phone, '04a-lead-pin-390');
  await phone.getByTestId('lead-pin').fill(LEAD_PIN);
  await phone.getByTestId('lead-pin-submit').click();
  await expect(phone.getByTestId('lead-offer')).toBeVisible();
  await expect(phone.getByTestId('narration-lead_briefing')).toBeVisible();
  await shot(phone, '04-lead-inbox-390');
  await shot(phone, '04b-lead-inbox-390-full', true);
  await phone.getByTestId('lead-approve').click();
  await expect(phone.getByTestId('lead-empty')).toBeVisible();

  await expect(card.getByTestId('offer-status')).toHaveText('DELIVERED');
  await shot(page, '05-command-center-offer-delivered');

  await phone.goto(await offerLink(card));
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

  // Final build: incidents, next best action, surge radar, standby bench, timeline, policy, rewind, quality, standby phone.
  await page.getByTestId('now-mode-incidents').click();
  await expect(page.getByTestId('incident-card').first()).toBeVisible();
  await shot(page, '15-incidents-and-next-actions');
  await page.getByTestId('tab-radar').click();
  await expect(page.getByTestId('radar-row').first()).toBeVisible();
  await shot(page, '16-surge-radar');
  await page.getByTestId('tab-bench').click();
  await expect(page.locator('[data-testid=bench-card]').first()).toBeVisible();
  await shot(page, '17-standby-bench');
  await page.getByTestId('tab-timeline').click();
  await expect(page.getByTestId('horizon-timeline')).toBeVisible();
  await shot(page, '18-horizon-timeline');
  await page.getByTestId('tab-policy').click();
  await shot(page, '19-policy-panel');
  await page.getByTestId('tab-bench').click();
  await page.locator('[data-testid=bench-card]').first().getByTestId('bench-prealert').click();
  await phone.goto('/lead');
  await expect(phone.getByTestId('lead-standby')).toBeVisible();
  await shot(phone, '20-lead-standby-390');
  await phone.getByTestId('lead-approve-standby').click();
  const benchCard = page.locator('[data-testid=bench-card]').first();
  await expect(benchCard.getByTestId('standby-status')).toHaveText('Pre-alert sent');
  const sbHref = (await benchCard.getByTestId('standby-link').getAttribute('href')) ?? '';
  await phone.goto(sbHref);
  await expect(phone.getByTestId('standby-headline')).toBeVisible();
  await shot(phone, '21-standby-phone-390');
  await page.goto('/rewind');
  await expect(page.getByTestId('rewind')).toBeVisible({ timeout: 30_000 });
  await shot(page, '22-rewind');
  await page.goto('/quality');
  await expect(page.getByTestId('quality-table')).toBeVisible();
  await shot(page, '23-quality');

  // Dataset admin: a package with the brief's own headers ("Event time", "Phys."), not activated.
  const RAW = new URL('../../../data/raw/', import.meta.url);
  const upload = readdirSync(RAW)
    .filter((n) => n.endsWith('.csv'))
    .map((name) => {
      const text = readFileSync(new URL(name, RAW), 'utf8');
      const renamed = name === 'event_stream.csv' ? 'Event,Event time,Ingested,Consult,Type,Phys.,Hosp.,Description' + text.slice(text.search(/\r?\n/)) : text;
      return { name, mimeType: 'text/csv', buffer: Buffer.from(renamed) };
    });
  await page.goto('/admin/dataset');
  await page.getByTestId('dataset-files').setInputFiles(upload);
  await expect(page.getByTestId('snapshot-check')).toBeVisible();
  await shot(page, '24-admin-dataset-report');
  await phoneCtx.close();
});
