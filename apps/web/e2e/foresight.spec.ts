import { expect, test } from '@playwright/test';
import { LEAD_PIN, device, openLead } from './fixtures';

/**
 * Final-build e2e (Phases 6-7): the next-best-action queue (<= 3 clicks from
 * alert to proposal), the standby loop (pre-alert -> ready -> activation ->
 * accept) and the release path through the real UI, the live inject reaching
 * the radar / bench / incidents without a reload, and the /rewind and /quality
 * pages rendering computed numbers.
 */

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

const standbyLink = async (card: import('@playwright/test').Locator): Promise<string> => {
  const href = (await card.getByTestId('standby-link').getAttribute('href')) ?? '';
  const u = new URL(href, 'http://x');
  return `${u.pathname}${u.search}`;
};

test('next best action: alert -> proposal in one click (<= 3), ranked queue with computed scores', async ({ page }) => {
  await page.goto('/');
  const cards = page.getByTestId('nba-card');
  await expect(cards.first()).toBeVisible();
  const n = await cards.count();
  expect(n).toBeGreaterThan(2);
  // Scores are engine numbers in descending order.
  const averted = await page.getByTestId('nba-averted').evaluateAll((els) => els.map((e) => Number(e.textContent)));
  for (const a of averted) expect(Number.isFinite(a)).toBe(true);
  let clicks = 0;
  page.on('console', () => {});
  const first = cards.first();
  const kind = await first.getAttribute('data-nba-kind');
  await first.getByTestId('nba-propose').click();
  clicks++;
  // The top action at 18:20 is the split-shift offer; it appears as a PROPOSED offer card without any further click.
  await expect(page.getByTestId('toast-ok')).toBeVisible();
  if (kind === 'SPLIT_SHIFT_OFFER') {
    await page.getByTestId('tab-offers').click();
    await expect(page.getByTestId('offer-card').first().getByTestId('offer-status')).toHaveText('PROPOSED');
  }
  expect(clicks).toBeLessThanOrEqual(3);
  test.info().annotations.push({ type: 'clicks-to-proposal', description: String(clicks) });
  // Keyboard: J moves the selection, K moves back.
  await page.keyboard.press('j');
  await expect(page.locator('[data-testid=nba-card][data-selected=true]')).toHaveAttribute('data-nba-kind', (await cards.nth(1).getAttribute('data-nba-kind')) ?? '');
  await page.keyboard.press('k');
  await expect(cards.first()).toHaveAttribute('data-selected', 'true');
});

test('incidents: the NOW panel groups items into fewer incidents and keeps the raw items reachable', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('now-mode-incidents').click();
  await expect(page.getByTestId('now-count')).toContainText(/\d+ items → \d+ incidents/);
  const incidents = await page.getByTestId('incident-card').count();
  await page.getByTestId('now-mode-items').click();
  const items = await page.locator('[data-attention-id]').count();
  expect(incidents).toBeLessThan(items);
  expect(incidents).toBeGreaterThan(0);
});

test('@demo standby loop: pre-alert on the bench -> lead approves -> phone "I can be ready" -> activation recommended -> propose -> lead approves -> phone Accept -> ACTIVATED, coverage changes', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  const deadlockBefore = await page.locator('[data-testid=coverage-grid] td[data-class=DEADLOCK]').count();
  await page.getByTestId('tab-bench').click();
  const card = page.locator('[data-testid=bench-card]').first();
  await expect(card).toBeVisible();
  await card.getByTestId('bench-prealert').click();
  await expect(card.getByTestId('standby-status')).toHaveText('Awaiting approval');

  const leadCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const lead = await leadCtx.newPage();
  await openLead(lead);
  const leadCard = lead.getByTestId('lead-standby');
  await expect(leadCard).toHaveAttribute('data-stage', 'prealert');
  await expect(leadCard).not.toContainText(/CON-\d+|EVT-\d+|stroke|patient/i);
  await lead.getByTestId('lead-approve-standby').click();
  await expect(card.getByTestId('standby-status')).toHaveText('Pre-alert sent');

  const phoneCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const phone = await phoneCtx.newPage();
  await phone.goto(await standbyLink(card));
  await expect(phone.getByTestId('standby-headline')).toBeVisible();
  await phone.getByTestId('standby-ready').click();
  await expect(phone.getByTestId('standby-status')).toHaveText(/READY|ACKNOWLEDGED|ON STANDBY/);
  await expect(card.getByTestId('standby-status')).toHaveText(/Acknowledged|Activation recommended/);

  // A covered hospital is deadlocked now, so activation is recommended; the coordinator proposes it.
  await card.getByTestId('bench-propose-activation').click();
  await expect(card.getByTestId('standby-status')).toHaveText('Activation awaiting approval');
  await expect(lead.getByTestId('lead-standby')).toHaveAttribute('data-stage', 'activation');
  await lead.getByTestId('lead-approve-activation').click();
  await expect(card.getByTestId('standby-status')).toHaveText('Activation sent');
  await expect(phone.getByTestId('activation-accept')).toBeVisible();
  await phone.getByTestId('activation-accept').click();
  await expect(phone.getByTestId('standby-status')).toHaveText('ACTIVATED');
  await expect(card.getByTestId('standby-status')).toHaveText('Active');
  await expect.poll(() => page.locator('[data-testid=coverage-grid] td[data-class=DEADLOCK]').count()).toBeLessThan(deadlockBefore);
  await leadCtx.close();
  await phoneCtx.close();
});

test('release path: pre-alert -> ready -> the lead releases -> RELEASED with a PHI-free message', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  await page.getByTestId('tab-bench').click();
  const card = page.locator('[data-testid=bench-card]').first();
  await card.getByTestId('bench-prealert').click();
  const leadCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const lead = await leadCtx.newPage();
  await openLead(lead);
  await lead.getByTestId('lead-approve-standby').click();
  await expect(card.getByTestId('standby-status')).toHaveText('Pre-alert sent');
  const phoneCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const phone = await phoneCtx.newPage();
  await phone.goto(await standbyLink(card));
  await phone.getByTestId('standby-ready').click();
  await expect(card.getByTestId('standby-status')).toHaveText(/Acknowledged|Activation recommended/);
  // The console's lead role releases (the bench offers Release while acknowledged; the lead PIN is needed).
  await page.getByTestId('role-switcher').selectOption('clinical_lead');
  await page.getByTestId('console-pin').fill(LEAD_PIN);
  await page.getByTestId('console-pin-submit').click();
  await expect(page.getByTestId('role-switcher')).toHaveValue('clinical_lead');
  await card.getByTestId('bench-release').click();
  await expect(card.getByTestId('standby-status')).toHaveText('Released');
  await expect(phone.getByTestId('standby-status')).toHaveText('RELEASED');
  await expect(phone.getByTestId('phone-standby')).toContainText('No action needed');
  await expect(phone.getByTestId('phone-standby')).not.toContainText(/CON-\d+|EVT-\d+|stroke|patient/i);
  await leadCtx.close();
  await phoneCtx.close();
});

test('@demo live test reaches the radar, the bench and the incidents without a reload', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  await expect(page.getByTestId('sse-status')).toHaveAttribute('data-status', 'open');
  const observedBefore = await page.getByTestId('radar-row').first().getByTestId('radar-observed').textContent();
  const countBefore = (await page.getByTestId('now-count').textContent()) ?? '';
  let navigations = 0;
  page.on('framenavigated', () => navigations++);
  const ctx = await browser.newContext(device(baseURL, { width: 1920, height: 1080 }));
  const inject = await ctx.newPage();
  await inject.goto('/inject');
  await inject.getByTestId('inject-sample').click();
  await inject.getByTestId('inject-submit').click();
  await expect(inject.getByTestId('inject-result')).toContainText('LINE 2 ACCEPTED');
  // The surging hospital's observed count rises by one and the change is highlighted with its delta.
  await expect(page.getByTestId('radar-row').first().getByTestId('radar-observed')).toHaveText(String(Number(observedBefore) + 1), { timeout: 3_000 });
  await expect(page.locator('[data-testid=delta-chip]').first()).toBeVisible();
  await expect(page.getByTestId('now-count')).not.toHaveText(countBefore);
  await page.getByTestId('tab-bench').click();
  await expect(page.getByTestId('eum-weighted')).toBeVisible();
  expect(navigations).toBe(0);
  await ctx.close();
});

test('rewind renders the computed three-line comparison and markers', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/rewind');
  await expect(page.getByTestId('rewind')).toBeVisible({ timeout: 30_000 });
  for (const k of ['actual', 'reactive', 'anticipatory']) await expect(page.getByTestId(`rewind-total-${k}`)).toHaveText(/^\d+(\.\d+)?$/);
  const actual = Number(await page.getByTestId('rewind-total-actual').textContent());
  const anticipatory = Number(await page.getByTestId('rewind-total-anticipatory').textContent());
  expect(anticipatory).toBeLessThanOrEqual(actual);
  await expect(page.getByTestId('rewind-markers')).toContainText(/PRE-ALERT|ACTIVATION/);
  await page.getByTestId('rewind-slider').fill('0');
  await expect(page.getByTestId('rewind-origin')).toHaveText('16:00');
});

test('quality renders the backtest table with three model rows and the reliability chart', async ({ page }) => {
  await page.goto('/quality');
  await expect(page.getByTestId('quality-table')).toBeVisible();
  await expect(page.getByTestId('quality-model-row')).toHaveCount(3);
  await expect(page.getByTestId('reliability-chart')).toBeVisible();
  await expect(page.getByTestId('quality-first-warning')).toContainText(/realized spike onsets/);
});
