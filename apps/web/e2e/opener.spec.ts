import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Sprint A1/A3 e2e (LOOKAHEAD-DEFINED opener + clinical impact): /opener
 * renders three computed sentences with no placeholder text and its start
 * button goes to the Command Center; /?opener=1 overlays a dismissible modal;
 * /rewind shows the impact sentence; /clinical-sources renders the citation.
 * Expectations are derived from /api/rewind, never hard-coded.
 */

const PLACEHOLDER = /undefined|NaN|\bnull\b|\{|TODO/;

interface RewindLike {
  readonly assumptions: { readonly leadApprovalMin: number; readonly ackMin: number; readonly activationApprovalMin: number; readonly acceptMin: number };
  readonly lines: readonly { readonly kind: string; readonly totalStrokeMinutesUnassigned: number }[];
}

async function rewindReport(request: APIRequestContext): Promise<RewindLike | null> {
  const r = await request.get('/api/rewind');
  return r.ok() ? ((await r.json()) as RewindLike) : null;
}

/** Same arithmetic as the engine's impactSummary without untilMs: round1(max(0, actual - anticipatory)). */
function averted(r: RewindLike): number {
  const total = (k: string) => r.lines.find((l) => l.kind === k)?.totalStrokeMinutesUnassigned ?? 0;
  return Math.round(Math.max(0, total('actual') - total('anticipatory')) * 10) / 10;
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

test('/opener: three computed sentences, timeline, impact counter, assumptions; start goes to /', async ({ page, request }) => {
  const report = await rewindReport(request);
  await page.goto('/opener');
  const root = page.getByTestId('opener');
  await expect(root).toBeVisible();
  expect(await root.innerText()).not.toMatch(PLACEHOLDER);
  const assumptions = page.getByTestId('opener-assumptions');
  await expect(assumptions).toBeVisible();
  if (report !== null && (await page.getByTestId('opener-empty').count()) === 0) {
    const sentences = page.getByTestId('opener-sentence');
    await expect(sentences).toHaveCount(3);
    for (const s of await sentences.all()) {
      await expect(s).toBeVisible();
      expect((await s.innerText()).trim().length).toBeGreaterThan(10);
    }
    await expect(page.getByTestId('opener-timeline')).toBeVisible();
    const impact = page.getByTestId('opener-impact');
    await expect(impact).toBeVisible();
    const x = averted(report);
    if (x > 0) await expect(impact).toContainText(`${x} stroke consult-minutes averted`);
    else await expect(impact).toContainText('No stroke consult-minutes averted');
    await expect(impact.getByRole('link')).toHaveAttribute('href', '/clinical-sources');
    await assumptions.locator('summary').click();
    for (const v of [report.assumptions.leadApprovalMin, report.assumptions.ackMin, report.assumptions.activationApprovalMin, report.assumptions.acceptMin]) await expect(assumptions).toContainText(`${v} min`);
  }
  await page.getByTestId('opener-start').click();
  await expect(page).toHaveURL(/\/$/);
});

test('/?opener=1 shows the opener modal over the Command Center and it closes', async ({ page }) => {
  await page.goto('/?opener=1');
  const modal = page.getByTestId('opener-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId('opener')).toBeVisible();
  expect(await modal.getByTestId('opener').innerText()).not.toMatch(PLACEHOLDER);
  await page.getByTestId('opener-close').click();
  await expect(modal).toBeHidden();
});

test('/ without ?opener=1 shows no modal', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('opener-modal')).toHaveCount(0);
});

test('/rewind shows the impact sentence (matching the line totals at the last origin) and the honesty footer', async ({ page, request }) => {
  const report = await rewindReport(request);
  test.skip(report === null, 'rewind not available');
  await page.goto('/rewind');
  const sentence = page.getByTestId('impact-sentence');
  await expect(sentence).toBeVisible();
  const text = await sentence.innerText();
  expect(text).not.toMatch(PLACEHOLDER);
  const x = report === null ? 0 : averted(report);
  if (x > 0) await expect(sentence).toContainText(`averted ${x} stroke consult-minutes`);
  else await expect(sentence).toContainText('anticipation did not reduce stroke delay');
  await expect(page.getByTestId('impact-footer')).toContainText('Not a clinical outcome measurement');
  // Moving the slider to the first origin re-clips the totals client-side: the sentence stays computed.
  await page.getByTestId('rewind-slider').fill('0');
  expect(await sentence.innerText()).not.toMatch(PLACEHOLDER);
});

test('/clinical-sources renders the citation and the constants', async ({ page }) => {
  await page.goto('/clinical-sources');
  const root = page.getByTestId('clinical-sources');
  await expect(root).toBeVisible();
  const cite = page.getByTestId('clinical-citation');
  await expect(cite).toBeVisible();
  expect(await cite.innerText()).toMatch(/\b(19|20)\d{2}\b/);
  expect(await root.innerText()).not.toMatch(PLACEHOLDER);
});
