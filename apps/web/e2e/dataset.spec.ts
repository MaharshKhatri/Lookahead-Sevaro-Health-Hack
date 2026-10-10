import { readFileSync, readdirSync } from 'node:fs';
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test';
import { LEAD_PIN, TOP_ATTENTION } from './fixtures';

/**
 * Session 7 dataset swap through /admin/dataset: upload with renamed headers
 * (the brief's own table headers), ingest report, snapshot check, activate
 * behind the lead PIN, revert; and a package whose replay no longer matches
 * its snapshot (activation allowed, red banner linking to /integrity).
 */

const RAW = new URL('../../../data/raw/', import.meta.url);
const raw: Record<string, string> = Object.fromEntries(
  readdirSync(RAW)
    .filter((n) => n.endsWith('.csv'))
    .map((n) => [n, readFileSync(new URL(n, RAW), 'utf8')]),
);
const replaceHeader = (text: string, header: string) => header + text.slice(text.search(/\r?\n/));
const files = (m: Record<string, string>) => Object.entries(m).map(([name, text]) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) }));

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

// Whatever happens in a test, leave the server on data/raw for the next spec.
test.afterEach(async ({ baseURL }) => {
  const api = await playwrightRequest.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  for (let i = 0; i < 3; i++) {
    const ds = (await (await api.get('/api/dataset')).json()) as { active: { source: string } };
    if (ds.active.source === 'raw') break;
    await api.post('/api/auth/lead', { data: { pin: LEAD_PIN } });
    await api.post('/api/dataset/revert');
  }
  await api.dispose();
});

async function activateWithPin(page: Page): Promise<void> {
  await page.getByTestId('activate-dataset').click();
  await page.getByTestId('console-pin').fill(LEAD_PIN);
  await page.getByTestId('console-pin-submit').click();
}

test('renamed headers ("Event time", "Phys.") ingest with 8/8 and 18/18; activate swaps the dataset; revert restores data/raw', async ({ page }) => {
  await page.goto('/admin/dataset');
  const before = (await page.getByTestId('active-dataset').getAttribute('data-key')) ?? '';
  const renamed = { ...raw, 'event_stream.csv': replaceHeader(raw['event_stream.csv'] ?? '', 'Event,Event time,Ingested,Consult,Type,Phys.,Hosp.,Description') };
  await page.getByTestId('dataset-files').setInputFiles(files(renamed));

  const report = page.getByTestId('ingest-report');
  await expect(report).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('snapshot-check')).toContainText('8/8');
  await expect(page.getByTestId('snapshot-check')).toContainText('18/18');
  await expect(page.getByTestId('snapshot-check')).toContainText('0 cell diffs');
  await expect(page.getByTestId('ingest-file').filter({ hasText: 'event_stream.csv' })).toContainText('Phys.');

  await activateWithPin(page);
  await expect(page.getByTestId('active-dataset')).not.toHaveAttribute('data-key', before);
  await expect(page.getByTestId('revert-dataset')).toBeVisible();

  await page.goto('/');
  await expect(page.getByTestId('attention-top').getByTestId('attention-headline')).toHaveText(TOP_ATTENTION?.headline ?? '');
  await expect(page.getByTestId('snapshot-mismatch-banner')).toHaveCount(0);

  await page.goto('/admin/dataset');
  await page.getByTestId('revert-dataset').click();
  await expect(page.getByTestId('active-dataset')).toHaveAttribute('data-key', before);
});

test('a package whose replay differs from its snapshot can still be activated, with a red banner linking to /integrity', async ({ page }) => {
  await page.goto('/admin/dataset');
  const lines = (raw['event_stream.csv'] ?? '').trimEnd().split(/\r?\n/);
  const truncated = { ...raw, 'event_stream.csv': lines.slice(0, -20).join('\n') + '\n' };
  await page.getByTestId('dataset-files').setInputFiles(files(truncated));
  await expect(page.getByTestId('ingest-report')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('snapshot-check')).toContainText('Replay differs from your snapshot');
  await expect(page.getByTestId('activate-dataset')).toBeEnabled();

  await activateWithPin(page);
  await page.goto('/');
  const banner = page.getByTestId('snapshot-mismatch-banner');
  await expect(banner).toContainText(/Replay differs from your snapshot: \d+ cells/);
  await banner.getByRole('link').click();
  await expect(page).toHaveURL(/\/integrity$/);
});
