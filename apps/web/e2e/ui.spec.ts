import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openLead } from './fixtures';

/**
 * UI pass verification: accessibility (axe-core: no serious or critical
 * violations), theme toggle, keyboard navigation, live updates of the Horizon
 * Line without a reload, no horizontal scroll at 1280x800 and 390x844, the
 * command palette and the shortcut sheet.
 */

/** Hydrated: the status line renders only after a client fetch, so its presence means React is attached (networkidle never comes: SSE stays open). */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await expect(page.getByTestId('status-pill')).toBeVisible({ timeout: 15_000 });
}

async function axe(page: Page, label: string): Promise<void> {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${label}: ${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0]?.target.join(' ') ?? ''}`)).toEqual([]);
}

async function standbyPath(page: Page): Promise<string> {
  const view = (await (await page.request.get('/api/view')).json()) as { standby: { plan: { selected: { physicianId: string }[] } } };
  const physicianId = view.standby.plan.selected[0]?.physicianId ?? '';
  const r = await page.request.post('/api/commands', { headers: { 'content-type': 'application/json', 'x-lookahead-role': 'coordinator', 'x-lookahead-actor-id': 'coordinator-on-duty' }, data: { command: { type: 'proposeStandby', physicianId, commandId: `ui-${Date.now()}` } } });
  expect(r.status()).toBe(200);
  const v2 = (await (await page.request.get('/api/view')).json()) as { standby: { standbys: { standbyPath: string }[] } };
  return v2.standby.standbys[0]?.standbyPath ?? '';
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/demo/reset');
});

test('axe: no serious or critical violations on /, /opener, /rewind, /lead, /standby/[id]', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const path of ['/', '/opener', '/rewind']) {
    await page.goto(path);
    await settled(page);
    await axe(page, path);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await openLead(page);
  await axe(page, '/lead');
  const sb = await standbyPath(page);
  expect(sb).toMatch(/^\/standby\//);
  await page.goto(sb);
  await settled(page);
  await axe(page, '/standby/[id]');
});

test('theme toggle: T switches Night and Day and the choice survives a reload', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.locator('body').press('t');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.reload();
  await settled(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await page.locator('body').press('t');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
});

test('keyboard: J/K move the next-best-action selection; ? opens the shortcut sheet; Ctrl+K palette jumps to a page', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  const cards = page.getByTestId('nba-card');
  await expect(cards.first()).toBeVisible();
  const n = await cards.count();
  test.skip(n < 2, 'needs two next best actions');
  await expect(cards.nth(0)).toHaveAttribute('data-selected', 'true');
  await page.locator('body').press('j');
  await expect(cards.nth(1)).toHaveAttribute('data-selected', 'true');
  await page.locator('body').press('k');
  await expect(cards.nth(0)).toHaveAttribute('data-selected', 'true');
  await page.locator('body').press('?');
  await expect(page.getByTestId('shortcuts-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts-sheet')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('rewind');
  await page.keyboard.press('Enter');
  await page.waitForURL('**/rewind');
});

test('live: a clock move updates the Horizon Line without a reload', async ({ page, request }) => {
  await page.goto('/');
  await settled(page);
  const line = page.getByTestId('horizon-line');
  await expect(line).toBeVisible();
  const before = (await line.locator('text').filter({ hasText: /^now / }).textContent()) ?? '';
  const r = await request.post('/api/clock', { data: { action: 'advance', minutes: 5 } });
  expect(r.status()).toBe(200);
  await expect(line.locator('text').filter({ hasText: /^now / })).not.toHaveText(before, { timeout: 3_000 });
});

for (const vp of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`no horizontal scroll at ${vp.width}x${vp.height}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(vp);
    for (const path of ['/', '/opener', '/rewind', '/architecture', '/design']) {
      await page.goto(path);
      await settled(page);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${path} overflows by ${over}px`).toBeLessThanOrEqual(1);
    }
  });
}
