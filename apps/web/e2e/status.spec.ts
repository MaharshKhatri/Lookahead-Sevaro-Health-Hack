import { expect, test } from '@playwright/test';

/**
 * Sprint A6 e2e: the status pill renders on every page after mount and says
 * only what /api/health proved; the modal lists the deploy facts. Expected
 * text is derived from the same /api/health response, never assumed.
 */

interface Health {
  readonly live: boolean;
  readonly events: number;
  readonly checks: { readonly dynamo: { readonly status: string }; readonly bedrock: { readonly status: string } };
  readonly testReport: { readonly total: { readonly passed: number; readonly tests: number } } | null;
  readonly deployedUrl: string | null;
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

test('@demo status pill and modal render, honest about AWS', async ({ page, request }) => {
  const h = (await (await request.get('/api/health')).json()) as Health;
  await page.goto('/');
  const pill = page.getByTestId('status-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('data-live', h.live ? 'true' : 'false');
  if (h.live) {
    await expect(pill).toContainText('Live on AWS');
    await expect(pill).toContainText(`${h.events.toLocaleString('en-US')} events`);
  } else {
    await expect(pill).toContainText('Local engine');
    await expect(pill).not.toContainText('Live on AWS');
    const notConfigured = [h.checks.dynamo.status, h.checks.bedrock.status].every((s) => s === 'not_configured');
    if (notConfigured) await expect(pill).toHaveText('Local engine');
  }

  await pill.click();
  const modal = page.getByTestId('status-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('DynamoDB');
  await expect(modal).toContainText('Bedrock');
  await expect(modal).toContainText('Last webhook');
  if (h.testReport === null) await expect(modal).toContainText('no test report yet');
  else await expect(modal).toContainText(`${h.testReport.total.passed}/${h.testReport.total.tests} passed`);
  if (h.deployedUrl !== null) await expect(modal).toContainText(h.deployedUrl);
  await expect(modal.locator('a[href="/architecture"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
});

test('status pill is on other pages too', async ({ page }) => {
  for (const path of ['/state', '/integrity', '/lead']) {
    await page.goto(path);
    await expect(page.getByTestId('status-pill'), path).toBeVisible();
  }
});
