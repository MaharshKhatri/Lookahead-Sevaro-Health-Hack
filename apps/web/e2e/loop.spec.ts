import { expect, test } from '@playwright/test';
import { ELIGIBILITY, LEAD_PIN, TOP_ATTENTION, device, offerLink, openLead } from './fixtures';

/**
 * Session 6 e2e: the closed loop through the real UI (brief "What Teams Must
 * Demonstrate" #6: propose, approve, send (simulated), accept, update
 * projected coverage) and the live test (#8: inject a row, no restart).
 * Session 7: the lead unlocks /lead with the PIN and the physician opens the
 * tokenized link (OQ-44); decline, reject and expiry end in "escalation
 * suggested" when nobody else passes every rule (OQ-43). Tests tagged @demo
 * also run against a deployed server (e2e:remote).
 */

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

test('@demo closed loop: propose on "/" -> approve on /lead -> accept on /offer -> ACCEPTED, what-if and coverage update -> audit lists every physician considered', async ({ page, browser, baseURL }) => {
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
  await openLead(lead);
  await expect(lead.getByTestId('lead-offer')).toHaveAttribute('data-offer-id', offerId);
  await expect(lead.getByTestId('narration-lead_briefing')).toBeVisible();
  await lead.getByTestId('lead-approve').click();
  await expect(lead.getByTestId('lead-empty')).toBeVisible();

  // The console follows via SSE: delivered, with a QR to the physician's view.
  await expect(card.getByTestId('offer-status')).toHaveText('DELIVERED');
  await expect(card.getByTestId('offer-qr')).toBeVisible();
  await expect(card.getByTestId('offer-url')).toHaveText(new RegExp(`/offer/${offerId}\\?t=[A-Za-z0-9_-]{22}$`));

  // The physician accepts on their phone; the view shows only the message.
  const phoneCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const phone = await phoneCtx.newPage();
  await phone.goto(await offerLink(card));
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

test('@demo live test: an injected stroke consult at the surging hospital re-ranks attention on "/" within 2 s via SSE (no reload)', async ({ page, browser, baseURL }) => {
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

test('role gating: the clinical lead needs the PIN; Propose is disabled for the lead, and the API refuses the command with 403 FORBIDDEN_ROLE', async ({ page, request }) => {
  const propose = { command: { type: 'proposeOffer', physicianId: ELIGIBILITY.find((e) => e.eligible)?.physicianId } };
  const noPin = await request.post('/api/commands', { headers: { 'x-lookahead-role': 'clinical_lead' }, data: propose });
  expect(noPin.status()).toBe(401);
  expect((await noPin.json()).code).toBe('PIN_REQUIRED');

  await page.goto('/');
  await page.getByTestId('role-switcher').selectOption('clinical_lead');
  await page.getByTestId('console-pin').fill(LEAD_PIN);
  await page.getByTestId('console-pin-submit').click();
  await expect(page.getByTestId('role-switcher')).toHaveValue('clinical_lead');
  await expect(page.getByTestId('propose-offer')).toBeDisabled();
  const r = await page.request.post('/api/commands', { headers: { 'x-lookahead-role': 'clinical_lead' }, data: propose });
  expect(r.status()).toBe(403);
  expect((await r.json()).code).toBe('FORBIDDEN_ROLE');
});

test('offer link without its token is refused (page and API)', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  await page.getByTestId('propose-offer').click();
  const card = page.getByTestId('offer-card').first();
  const offerId = (await card.getAttribute('data-offer-id')) ?? '';
  const leadCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const lead = await leadCtx.newPage();
  await openLead(lead);
  await lead.getByTestId('lead-approve').click();
  await expect(card.getByTestId('offer-status')).toHaveText('DELIVERED');
  await page.goto(`/offer/${offerId}`);
  await expect(page.getByText('This offer link is not valid.')).toBeVisible();
  const r = await page.request.post('/api/commands', { headers: { 'x-lookahead-role': 'physician', 'x-lookahead-actor-id': 'x' }, data: { command: { type: 'respond', offerId, response: 'accept' }, token: 'forged' } });
  expect(r.status()).toBe(403);
  expect((await r.json()).code).toBe('BAD_TOKEN');
  await leadCtx.close();
});

/** Propose on "/" and, unless told otherwise, approve on /lead; returns the console's offer card. */
async function proposeAndApprove(page: import('@playwright/test').Page, browser: import('@playwright/test').Browser, baseURL: string | undefined, approve = true) {
  await page.goto('/');
  await expect(page.getByTestId('sse-status')).toHaveAttribute('data-status', 'open');
  await page.getByTestId('propose-offer').click();
  const card = page.getByTestId('offer-card').first();
  await expect(card.getByTestId('offer-status')).toHaveText('PROPOSED');
  const leadCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const lead = await leadCtx.newPage();
  await openLead(lead);
  if (approve) {
    await lead.getByTestId('lead-approve').click();
    await expect(card.getByTestId('offer-status')).toHaveText('DELIVERED');
  }
  return { card, lead, leadCtx };
}

test('@demo decline: the physician declines on the phone -> DECLINED, no next eligible physician -> escalation suggested', async ({ page, browser, baseURL }) => {
  const { card, leadCtx } = await proposeAndApprove(page, browser, baseURL);
  const phoneCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const phone = await phoneCtx.newPage();
  await phone.goto(await offerLink(card));
  await phone.getByTestId('offer-decline').click();
  await expect(phone.getByTestId('phone-status')).toHaveText('DECLINED');
  await expect(card.getByTestId('offer-status')).toHaveText('DECLINED');
  await expect(page.getByTestId('escalation-suggested')).toContainText('declined');
  await expect(page.getByTestId('escalation-suggested')).toContainText('Escalation suggested');
  await leadCtx.close();
  await phoneCtx.close();
});

test('reject: the clinical lead rejects with a reason -> REJECTED, escalation suggested, reason in the audit', async ({ page, browser, baseURL }) => {
  const { card, lead, leadCtx } = await proposeAndApprove(page, browser, baseURL, false);
  const offerId = (await card.getAttribute('data-offer-id')) ?? '';
  await lead.getByTestId('lead-reject-open').click();
  await lead.getByTestId('lead-reject-reason').fill('Coverage handled by phone tree tonight');
  await lead.getByTestId('lead-reject').click();
  await expect(lead.getByTestId('lead-empty')).toBeVisible();
  await expect(card.getByTestId('offer-status')).toHaveText('REJECTED');
  await expect(page.getByTestId('escalation-suggested')).toContainText('rejected');
  await page.goto(`/audit/${offerId}`);
  await expect(page.getByTestId('audit')).toContainText('Coverage handled by phone tree tonight');
  await leadCtx.close();
});

test('expiry: "+11m" past the 10-minute window -> EXPIRED on the console and the phone, escalation suggested', async ({ page, browser, baseURL }) => {
  const { card, leadCtx } = await proposeAndApprove(page, browser, baseURL);
  const phoneCtx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const phone = await phoneCtx.newPage();
  await phone.goto(await offerLink(card));
  await expect(phone.getByTestId('offer-accept')).toBeVisible();
  await page.getByTestId('advance-11').click();
  await expect(card.getByTestId('offer-status')).toHaveText('EXPIRED');
  await expect(phone.getByTestId('phone-status')).toHaveText('EXPIRED');
  await expect(phone.getByTestId('offer-accept')).toHaveCount(0);
  await expect(page.getByTestId('escalation-suggested')).toContainText('expired');
  await leadCtx.close();
  await phoneCtx.close();
});

test('Explain: the top attention card gets a plain-English briefing with a source badge (template when Bedrock is off)', async ({ page }) => {
  await page.goto('/');
  const top = page.getByTestId('attention-top');
  await top.getByTestId('explain-attention').click();
  const n = top.getByTestId('narration-attention');
  await expect(n).toHaveAttribute('data-source', 'template');
  await expect(n).toContainText('TEMPLATE');
  await expect(n).not.toContainText(/CON-\d+|EVT-\d+|stroke|patient|imaging/i);
});
