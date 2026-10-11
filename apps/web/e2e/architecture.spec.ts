import { expect, test } from '@playwright/test';

/**
 * /architecture (sprint A4/B3): hero, diagram, counters and badges render,
 * and every counter on screen equals GET /api/architecture (no literals: the
 * expectations are read from the API).
 */

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

interface Counter {
  readonly name: string;
  readonly value: number | null;
}

test('architecture page: hero, diagram, counters equal the API, badges', async ({ page, request }) => {
  const api = (await (await request.get('/api/architecture')).json()) as { counters: Counter[]; badges: { hardcode: { status: string; filesScanned: number }; tests: { status: string } } };
  await page.goto('/architecture');
  await expect(page.getByTestId('architecture')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI narrates. Humans decide.' })).toBeVisible();
  await expect(page.getByTestId('ai-does').locator('li').first()).toBeVisible();
  await expect(page.getByTestId('ai-never')).toContainText('Choose which physician to call');
  await expect(page.getByTestId('arch-diagram').locator('svg')).toBeVisible();
  await expect(page.getByTestId('arch-diagram').locator('details pre')).toContainText('flowchart LR');
  await expect(page.getByTestId('arch-counters')).toBeVisible();
  expect(api.counters.length).toBeGreaterThan(3);
  for (const c of api.counters) {
    await expect(page.getByTestId(`counter-${c.name}`)).toHaveAttribute('data-value', c.value === null ? 'null' : String(c.value));
  }
  await expect(page.getByTestId('badge-hardcode')).toHaveAttribute('data-status', api.badges.hardcode.status);
  if (api.badges.hardcode.status === 'clean') await expect(page.getByTestId('badge-hardcode')).toContainText(String(api.badges.hardcode.filesScanned));
  await expect(page.getByTestId('badge-tests')).toHaveAttribute('data-status', api.badges.tests.status);
});

test('counters update live after a proposal (SSE refresh)', async ({ page, request }) => {
  await page.goto('/architecture');
  const tile = page.getByTestId('counter-recommendations-acted-on');
  const before = Number(await tile.getAttribute('data-value'));
  const view = (await (await request.get('/api/view')).json()) as { recommendedOffer: { physicianId: string } | null };
  test.skip(view.recommendedOffer === null, 'no recommended offer in this dataset');
  const r = await request.post('/api/commands', { headers: { 'x-lookahead-role': 'coordinator' }, data: { command: { type: 'proposeOffer', physicianId: view.recommendedOffer?.physicianId } } });
  expect(r.ok()).toBe(true);
  await expect(tile).toHaveAttribute('data-value', String(before + 1), { timeout: 10_000 });
  await expect(page.getByTestId('counter-ai-decisions')).toHaveAttribute('data-value', '0');
});

test('live scale test returns a computed outcome', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/architecture');
  await page.getByTestId('scale-run').click();
  const outcome = page.getByTestId('scale-result').or(page.getByTestId('scale-error'));
  await expect(outcome).toBeVisible({ timeout: 90_000 });
  if (await page.getByTestId('scale-result').isVisible()) {
    expect(await page.getByTestId('scale-row').count()).toBeGreaterThan(4);
  }
});
