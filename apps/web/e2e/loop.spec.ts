import { expect, test } from '@playwright/test';
import { ELIGIBILITY, TOP_ATTENTION, device } from './fixtures';

/**
 * Session 6 e2e: the closed loop through the real UI (brief "What Teams Must
 * Demonstrate" #6: propose, approve, send (simulated), accept, update
 * projected coverage) and the live test (#8: inject a row, no restart).
 */

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

test('closed loop: propose on "/" -> approve on /lead -> accept on /offer -> ACCEPTED, what-if and coverage update -> audit lists every physician considered', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  const top = page.getByTestId('attention-top');
  await expect(top.getByTestId('attention-headline')).toHaveText(TOP_ATTENTION?.headline ?? '');
  await expect(top).toContainText('CRITICAL');
  await expect(page.getByTestId('sse-status')).toHaveAttribute('data-status', 'open');
  const deadlockCellsBefore = await page.locator('[data-testid=coverage-grid] td[data-class=DEADLOCK]').count();
  expect(deadlockCellsBefore).toBeGreaterThan(0);

  // Coordinator proposes the recommended split-shift offer.
  await page.getByTestId('propose-offer').click();
  const card = page.getByTestId('offer-card').first();
  await expect(card.getByTestId('offer-status')).toHaveText('PROPOSED');
  const offerId = (await card.getAttribute('data-offer-id')) ?? '';
  expect(offerId).not.toBe('');

  // Clinical lead approves on a phone.
  const leadCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const lead = await leadCtx.newPage();
  await lead.goto('/lead');
  await expect(lead.getByTestId('lead-offer')).toHaveAttribute('data-offer-id', offerId);
  await lead.getByTestId('lead-approve').click();
  await expect(lead.getByTestId('lead-empty')).toBeVisible();

  // The console follows via SSE: delivered, with a QR to the physician's view.
  await expect(card.getByTestId('offer-status')).toHaveText('DELIVERED');
  await expect(card.getByTestId('offer-qr')).toBeVisible();
  await expect(card.getByTestId('offer-url')).toHaveText(`${baseURL}/offer/${offerId}`);

  // The physician accepts on their phone; the view shows only the message.
  const phoneCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const phone = await phoneCtx.newPage();
  await phone.goto(`/offer/${offerId}`);
  await expect(phone.getByTestId('phone-message')).toContainText('Split-shift offer from the operations team.');
  await expect(phone.getByTestId('phone-message')).not.toContainText(/CON-\d+|EVT-\d+|stroke|patient|imaging/i);
  await expect(phone.getByTestId('phone-countdown')).toHaveText('10:00');
  await phone.getByTestId('offer-accept').click();
  await expect(phone.getByTestId('phone-status')).toHaveText('ACCEPTED');

  // Back on "/": ACCEPTED pill, the frozen what-if, and fewer deadlocked cells.
  await expect(card.getByTestId('offer-status')).toHaveText('ACCEPTED');
  await expect.poll(() => page.locator('[data-testid=coverage-grid] td[data-class=DEADLOCK]').count()).toBeLessThan(deadlockCellsBefore);
  await page.getByTestId('tab-whatif').click();
  await expect(page.getByTestId('whatif')).toHaveAttribute('data-source', 'accepted');
  await expect(page.locator('[data-testid=whatif-row][data-outcome=closed]').first()).toBeVisible();

  // Audit: who was considered (every off-shift physician), who approved, outcome.
  await page.goto(`/audit/${offerId}`);
  await expect(page.getByTestId('audit-physician')).toHaveCount(ELIGIBILITY.length);
  await expect(page.getByTestId('audit')).toContainText('Approved by clinical lead');
  await expect(page.getByTestId('audit')).toContainText('Outcome: accepted');
  await leadCtx.close();
  await phoneCtx.close();
});

test('live test: an injected stroke consult at the surging hospital re-ranks attention on "/" within 2 s via SSE (no reload)', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  await expect(page.getByTestId('sse-status')).toHaveAttribute('data-status', 'open');
  const idsBefore = await page.locator('[data-attention-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-attention-id')));
  let navigations = 0;
  page.on('framenavigated', () => navigations++);

  const ctx = await browser.newContext(device(baseURL, { width: 1920, height: 1080 }));
  const inject = await ctx.newPage();
  await inject.goto('/inject');
  await inject.getByTestId('inject-sample').click();
  const rows = await inject.getByTestId('inject-text').inputValue();
  const consultId = rows.split('\n')[1]?.split(',')[3] ?? '';
  expect(consultId).toMatch(/\S/);
  await inject.getByTestId('inject-submit').click();
  const submittedAt = Date.now();
  await expect(inject.getByTestId('inject-result')).toContainText('LINE 2 ACCEPTED');

  const newCard = page.locator('[data-attention-id]').filter({ hasText: consultId }).first();
  await expect(newCard).toBeVisible({ timeout: 2_000 });
  const elapsed = Date.now() - submittedAt;
  const idsAfter = await page.locator('[data-attention-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-attention-id')));
  expect(idsAfter).not.toEqual(idsBefore);
  expect(navigations).toBe(0);
  test.info().annotations.push({ type: 'rerank-ms', description: String(elapsed) });
  console.log(`attention re-ranked ${elapsed} ms after submit; new consult ${consultId} at rank ${idsAfter.indexOf(await newCard.getAttribute('data-attention-id')) + 1}`);
  await ctx.close();
});

test('role gating: Propose is disabled for the clinical lead, and the API refuses the command with 403 FORBIDDEN_ROLE', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('role-switcher').selectOption('clinical_lead');
  await expect(page.getByTestId('propose-offer')).toBeDisabled();
  const r = await page.request.post('/api/commands', { headers: { 'x-lookahead-role': 'clinical_lead' }, data: { command: { type: 'proposeOffer', physicianId: ELIGIBILITY.find((e) => e.eligible)?.physicianId } } });
  expect(r.status()).toBe(403);
  expect((await r.json()).code).toBe('FORBIDDEN_ROLE');
});
