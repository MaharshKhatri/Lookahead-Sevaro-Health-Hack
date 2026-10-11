import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { openLead } from './fixtures';

/**
 * UI pass screenshot critique set: /, /opener, /rewind, /lead, /standby/[id],
 * /architecture and /design at 1440x900, 1280x800 and 390x844, in Night and
 * Day, into docs/screens/ui/. The theme is chosen the way a person would
 * (the remembered T choice in localStorage) before the page loads.
 */
const OUT = fileURLToPath(new URL('../../../docs/screens/ui/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  { name: '390', width: 390, height: 844 },
] as const;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await expect(page.getByTestId('status-pill')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
}

test('UI screenshots: 7 pages x 3 sizes x Night/Day', async ({ browser, baseURL, request }) => {
  test.setTimeout(300_000);
  await request.post('/api/demo/reset');
  const view = (await (await request.get('/api/view')).json()) as { standby: { plan: { selected: { physicianId: string }[] } } };
  const physicianId = view.standby.plan.selected[0]?.physicianId ?? '';
  await request.post('/api/commands', { headers: { 'x-lookahead-role': 'coordinator', 'x-lookahead-actor-id': 'coordinator-on-duty' }, data: { command: { type: 'proposeStandby', physicianId, commandId: 'ui-screens-standby' } } });
  const v2 = (await (await request.get('/api/view')).json()) as { standby: { standbys: { standbyPath: string }[] } };
  const standby = v2.standby.standbys[0]?.standbyPath ?? '';
  for (const theme of ['night', 'day'] as const) {
    for (const size of SIZES) {
      const ctx = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: size.width, height: size.height }, ...(size.name === '390' ? { isMobile: true, hasTouch: true } : {}) });
      await ctx.addInitScript((t) => {
        try {
          localStorage.setItem('lh-theme', t);
        } catch {
          // ignore
        }
      }, theme);
      const page = await ctx.newPage();
      await openLead(page);
      for (const [name, path] of [
        ['console', '/'],
        ['opener', '/opener'],
        ['rewind', '/rewind'],
        ['lead', '/lead'],
        ['standby', standby],
        ['architecture', '/architecture'],
        ['design', '/design'],
      ] as const) {
        await page.goto(path);
        await settle(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.screenshot({ path: `${OUT}${name}-${size.name}-${theme}.png` });
      }
      await ctx.close();
    }
  }
});
