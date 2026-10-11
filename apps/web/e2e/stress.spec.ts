import { expect, test } from '@playwright/test';

/**
 * Stress test drawer (LOOKAHEAD-DEFINED): opened from ACT on "/", it lists
 * every action GET /api/stress returns under "Prove it" / "Break it"; each
 * click runs POST /api/stress and renders a result card (newest first). The
 * console behind the drawer stays usable while a run is in flight, Esc
 * closes the drawer, and the page logs no console errors. The action list
 * and every expected label come from the API response, never from this file.
 */

interface StressAction {
  readonly id: string;
  readonly group: 'prove' | 'break';
  readonly label: string;
  readonly description: string;
}
interface StressTotals {
  readonly handled: number;
  readonly errors: number;
  readonly seconds: number;
}

/** The contract's seeded action: its runs carry a seed shown on the card. */
const SEEDED_ACTION = 'random_chaos';

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

test('stress test: every prove / break action runs from the drawer and renders a result card; the console stays responsive; no console errors', async ({ page, request }) => {
  // Thirteen-odd actions, some of which (generalization, deterministic_forecast) take seconds each.
  test.setTimeout(300_000);
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  const catalogRes = await request.get('/api/stress');
  expect(catalogRes.ok()).toBe(true);
  const catalog = (await catalogRes.json()) as { actions: StressAction[]; totals: StressTotals };
  const actions = catalog.actions;
  expect(actions.length).toBeGreaterThan(0);

  await page.goto('/');
  await expect(page.getByTestId('panel-now')).toBeVisible();
  await page.getByTestId('stress-open').click();
  const panel = page.getByTestId('stress-panel');
  await expect(panel).toBeVisible();

  // One button per server action, each carrying the server's label, in its group.
  await expect(panel.locator('[data-testid^="stress-action-"]')).toHaveCount(actions.length);
  for (const a of actions) {
    await expect(panel.getByTestId(`stress-group-${a.group}`).getByTestId(`stress-action-${a.id}`)).toContainText(a.label);
  }
  if (actions.some((a) => a.group === 'prove')) await expect(panel.getByTestId('stress-group-prove')).toContainText('Prove it');
  if (actions.some((a) => a.group === 'break')) await expect(panel.getByTestId('stress-group-break')).toContainText('Break it');

  for (const [i, a] of actions.entries()) {
    const button = panel.getByTestId(`stress-action-${a.id}`);
    await button.click();
    if (i === 0) {
      // A run in flight never blocks the console behind the drawer.
      await page.getByTestId('tab-bench').click();
      await expect(page.getByTestId('tab-bench')).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('tab-radar').click();
      await expect(page.getByTestId('tab-radar')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('panel-now')).toBeVisible();
    }
    const card = panel.locator(`[data-testid="stress-result"][data-action="${a.id}"]`);
    await expect(card).toHaveCount(1, { timeout: 20_000 });
    await expect(card).toContainText(a.label);
    // Newest first.
    await expect(panel.getByTestId('stress-result').first()).toHaveAttribute('data-action', a.id);
    const ok = await card.getAttribute('data-ok');
    if (ok === 'true') {
      await expect(card.getByTestId('stress-result-state')).toHaveText('OK');
      await expect(card.getByTestId('stress-latency')).toHaveText(/^\d+(\.\d)? ms$/);
      await expect(card.getByTestId('stress-summary')).toBeVisible();
    } else {
      // A failed run is still a rendered card with its reason in words.
      await expect(card.getByTestId('stress-error')).toBeVisible();
      await expect(card.getByTestId('stress-error')).toHaveText(/\S/);
      await expect(card.getByTestId('stress-result-state')).toHaveText(/ERROR|FAILED/);
    }
    if (a.id === SEEDED_ACTION) {
      await expect(card).toHaveAttribute('data-seed', /^\d+$/);
      await expect(card.getByTestId('stress-seed')).toHaveText(/^seed \d+$/);
    }
    // The button comes back once its run ends.
    await expect(button).toBeEnabled();
    test.info().annotations.push({ type: `stress-${a.id}`, description: `ok=${ok}` });
  }
  await expect(panel.getByTestId('stress-result')).toHaveCount(actions.length);

  // Footer: the server's running totals, in the documented sentence.
  const footer = panel.getByTestId('stress-footer');
  await expect(footer).toHaveText(/^\d+ stress events? handled in \d+(\.\d+)?s · \d+ errors?$/);
  const shownHandled = Number(await footer.getAttribute('data-handled'));
  const shownErrors = Number(await footer.getAttribute('data-errors'));
  expect(shownHandled).toBeGreaterThan(0);
  const after = ((await (await request.get('/api/stress')).json()) as { totals: StressTotals }).totals;
  // Server totals only grow; the footer shows the value from the last response it received.
  expect(after.handled).toBeGreaterThanOrEqual(shownHandled);
  expect(after.errors).toBeGreaterThanOrEqual(shownErrors);
  await expect(footer.getByTestId('stress-errors')).toHaveText(String(shownErrors));

  // Esc closes; reopening keeps this session's result cards.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.getByTestId('stress-open').click();
  await expect(page.getByTestId('stress-panel').getByTestId('stress-result')).toHaveCount(actions.length);
  await page.getByTestId('stress-close').click();
  await expect(page.getByTestId('stress-panel')).toBeHidden();

  // The console is still live and clickable after the whole run.
  await page.getByTestId('tab-bench').click();
  await expect(page.getByTestId('tab-bench')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('tab-radar').click();
  await expect(page.getByTestId('tab-radar')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('panel-now')).toBeVisible();
  await expect(page.getByTestId('now-count')).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test('stress test API: an unknown action is refused with a 4xx JSON error', async ({ request }) => {
  const res = await request.post('/api/stress', { data: { action: 'not_a_stress_action' } });
  expect(res.status()).toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
  const body = (await res.json()) as { ok: boolean; code: string; message: string };
  expect(body.ok).toBe(false);
  expect(body.code).toMatch(/\S/);
});
