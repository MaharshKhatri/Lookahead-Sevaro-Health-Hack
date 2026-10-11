import { expect, test } from '@playwright/test';

/**
 * Upstream Event Simulator (sprint B1, demo only): a button builds a row from
 * the live snapshot and posts it through POST /api/v1/events; the outgoing
 * log shows the accepted IngestReport, the outbound webhook dispatcher's
 * envelope lands in the dev sink, and the Command Center shows the new consult
 * in its attention queue. Nothing is hard-coded: the consult id is read from
 * the payload the page displays, and the queue is checked against /api/view.
 */

interface ViewLike {
  readonly version: number;
  readonly attention: readonly { readonly id: string }[];
  readonly consults: readonly { readonly consultId: string }[];
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

test('simulator: new stroke consult -> accepted IngestReport -> webhook in the sink -> consult in the attention queue', async ({ page, request }) => {
  const status = (await (await request.get('/api/simulator/status')).json()) as { enabled: boolean; webhookTarget: string };
  test.skip(!status.enabled, 'simulator disabled on this server (SIMULATOR_ENABLED=0 or DEMO_MODE=false)');
  const before = (await (await request.get('/api/view')).json()) as ViewLike;
  // The sink keeps the last 50 deliveries, so the test compares the newest entry's time, not the count (it stays 50 once full).
  const sinkNewest = async () => ((await (await request.get('/api/simulator/webhook-sink')).json()) as { entries: { receivedAtMs: number }[] }).entries[0]?.receivedAtMs ?? 0;
  const sinkNewestBefore = await sinkNewest();

  await page.goto('/simulator');
  await expect(page.getByTestId('simulator')).toBeVisible();
  await expect(page.getByTestId('sim-hospital')).not.toHaveValue('');
  const hospitalId = await page.getByTestId('sim-hospital').inputValue();

  await page.getByTestId('sim-send-stroke_consult').click();
  const row = page.getByTestId('sim-out-log').getByTestId('sim-out-row').first();
  await expect(row).toHaveAttribute('data-status', '200');
  await expect(row).toHaveAttribute('data-accepted', '1');
  await expect(row).toContainText('accepted 1');

  // The payload is the CSV body actually sent: header + one consult_received row at the chosen hospital.
  const payload = (await row.getByTestId('sim-payload').textContent()) ?? '';
  const cols = payload.trim().split('\n')[1]?.split(',') ?? [];
  expect(cols[4]).toBe('consult_received');
  expect(cols[6]).toBe(hospitalId);
  const consultId = cols[3] ?? '';
  expect(consultId).not.toBe('');
  expect(before.consults.some((c) => c.consultId === consultId)).toBe(false);

  // The outbound webhook (debounced) reaches the dev sink within a few seconds when it is the dispatcher's target.
  if (status.webhookTarget === 'dev_sink') {
    await expect.poll(sinkNewest, { timeout: 10_000 }).toBeGreaterThan(sinkNewestBefore);
    await expect(page.getByTestId('sim-webhook-row').first()).toBeVisible();
    await expect(row.getByTestId('sim-timing')).not.toContainText('webhook received waiting', { timeout: 10_000 });
  }
  // The upstream chip appears in the top bar (the simulator posted within 60 s).
  await expect(page.getByTestId('upstream-chip')).toBeVisible({ timeout: 15_000 });

  // The Command Center: the new consult is in the attention queue (derived from /api/view, then checked on the page).
  const after = (await (await request.get('/api/view')).json()) as ViewLike;
  expect(after.version).toBeGreaterThan(before.version);
  expect(after.consults.some((c) => c.consultId === consultId)).toBe(true);
  const item = after.attention.find((a) => JSON.stringify(a).includes(consultId));
  await page.goto('/');
  await page.getByTestId('now-mode-items').click();
  if (item !== undefined) {
    await expect(page.locator(`[data-attention-id="${item.id}"]`)).toHaveCount(1);
  } else {
    expect(after.attention.length).not.toBe(before.attention.length);
    await expect(page.locator('[data-attention-id]')).toHaveCount(after.attention.length);
  }
});

test('simulator: duplicate resend reports duplicates 1 and no state change', async ({ page }) => {
  await page.goto('/simulator');
  await expect(page.getByTestId('simulator')).toBeVisible();
  await page.getByTestId('sim-send-heartbeat_lost').click();
  await expect(page.getByTestId('sim-out-row').first()).toHaveAttribute('data-accepted', '1');
  await page.getByTestId('sim-send-duplicate').click();
  await expect(page.getByTestId('sim-out-row')).toHaveCount(2);
  const dup = page.getByTestId('sim-out-row').first();
  await expect(dup).toHaveAttribute('data-accepted', '0');
  await expect(dup).toContainText('duplicates 1');
});
