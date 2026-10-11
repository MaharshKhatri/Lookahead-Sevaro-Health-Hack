import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { device } from './fixtures';

/**
 * Sprint A2 e2e: the patient clock band on every page follows the engine
 * (GET /api/patient-clock) through the live stream. Nothing is hard-coded:
 * hospitals, consults and physicians come from the API; injected rows use
 * ids generated at run time and event times just before the sim clock
 * (knowledge time, D-20: ingested_at defaults to the clock).
 */

interface Clock {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly unassignedSinceMs: number;
  readonly routingFailureCount: number;
  readonly credentialedRoutableNow: number;
  readonly credentialedTotal: number;
  readonly severity: 'critical' | 'warning';
  readonly candidateCount: number;
}
interface Payload {
  readonly clock: Clock | null;
  readonly nowMs: number;
  readonly clockMode: 'paused' | 'playing';
  readonly clockSpeed: number;
  readonly version: number;
}

const SSE_CYCLE_MS = 3_000;
const RUN = String(Date.now() % 100_000).padStart(5, '0');
let seq = 0;
const nextId = (prefix: 'EVT' | 'CON') => `${prefix}-9${RUN}${String(seq++).padStart(2, '0')}`;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const getClock = async (request: APIRequestContext): Promise<Payload> => (await (await request.get('/api/patient-clock')).json()) as Payload;

async function inject(request: APIRequestContext, row: string): Promise<void> {
  const r = await request.post('/api/events', { headers: { 'content-type': 'text/csv' }, data: row });
  expect(r.ok(), await r.text()).toBe(true);
  const b = (await r.json()) as { rejected: unknown[]; accepted: unknown[] };
  expect(b.rejected).toEqual([]);
  expect(b.accepted.length).toBe(1);
}

async function anyPhysicianId(request: APIRequestContext): Promise<string> {
  const v = (await (await request.get('/api/view')).json()) as { physicians: { physicianId: string }[] };
  const id = v.physicians[0]?.physicianId ?? '';
  expect(id).not.toBe('');
  return id;
}

/** The band shows exactly what the API says (or the clear bar when the API says nothing is on the clock). */
async function expectBandMatches(page: Page, p: Payload): Promise<void> {
  if (p.clock === null) {
    await expect(page.getByTestId('patient-clock-clear')).toBeVisible({ timeout: SSE_CYCLE_MS });
    await expect(page.getByTestId('patient-clock')).toHaveCount(0);
    return;
  }
  const band = page.getByTestId('patient-clock');
  await expect(band).toHaveAttribute('data-consult-id', p.clock.consultId, { timeout: SSE_CYCLE_MS });
  await expect(page.getByTestId('patient-clock-hospital')).toHaveText(p.clock.hospitalName, { timeout: SSE_CYCLE_MS });
  await expect(band).toHaveAttribute('data-severity', p.clock.severity);
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/demo/reset')).ok()).toBe(true);
});

test('@demo patient clock band and AI banner render engine values on "/" and on other pages', async ({ page, request }) => {
  const p = await getClock(request);
  await page.goto('/');
  await expect(page.getByTestId('ai-banner')).toContainText('AI narrates. Humans decide.');
  await expect(page.getByTestId('ai-banner').locator('a[href="/architecture"]')).toBeVisible();
  await expectBandMatches(page, p);
  if (p.clock !== null) {
    const c = p.clock;
    await expect(page.getByTestId('patient-clock-failures')).toContainText(`${c.routingFailureCount} routing`);
    await expect(page.getByTestId('patient-clock-available')).toContainText(`${c.credentialedRoutableNow} of ${c.credentialedTotal} credentialed physicians available`);
    await expect(page.getByTestId('patient-clock-neurons')).toHaveAttribute('href', '/clinical-sources');
    await expect(page.getByTestId('patient-clock-neurons')).toContainText('neurons at risk (estimate)');
    if (p.clockMode === 'paused') {
      await expect(page.getByTestId('patient-clock-paused')).toBeVisible();
      await expect(page.getByTestId('patient-clock-elapsed')).toHaveText(mmss(p.nowMs - c.unassignedSinceMs));
    } else {
      await expect(page.getByTestId('patient-clock-elapsed')).toHaveText(/^\d{2,}:\d{2}$/);
    }
  }
  // Every page carries the chrome; on another page a click on the band returns to "/".
  await page.goto('/state');
  await expect(page.getByTestId('ai-banner')).toBeVisible();
  if (p.clock !== null) {
    await expect(page.getByTestId('patient-clock-hospital')).toHaveText(p.clock.hospitalName);
    await page.getByTestId('patient-clock-hospital').click();
    await expect(page).toHaveURL(/\/$/);
  }
});

test('@demo the console still fits the viewport under the chrome (no page scroll)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('ai-banner')).toBeVisible();
  await expect(page.getByTestId('attention-top')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(2);
});

test('patient clock follows the stream: assignments move or collapse it, and a stroke consult at a blocked hospital appears within one SSE cycle', async ({ page, request }) => {
  const first = await getClock(request);
  expect(first.clock, 'reference data has an unassigned stroke consult at the sim clock').not.toBeNull();
  const c0 = first.clock;
  if (c0 === null) return;
  await page.goto('/');
  await expectBandMatches(page, first);
  const physicianId = await anyPhysicianId(request);

  // Assign whatever the engine puts on the clock until nothing is left (bounded by the candidate count).
  let current: Payload = first;
  for (let i = 0; current.clock !== null && i <= c0.candidateCount; i++) {
    const top = current.clock;
    await inject(request, `${nextId('EVT')},${iso(current.nowMs - 30_000 + i * 1_000)},,${top.consultId},physician_assigned,${physicianId},${top.hospitalId},Consult assigned`);
    await expect.poll(async () => (await getClock(request)).clock?.consultId ?? null).not.toBe(top.consultId);
    current = await getClock(request);
    await expectBandMatches(page, current);
  }
  expect(current.clock).toBeNull();
  await expect(page.getByTestId('patient-clock-clear')).toHaveText('All stroke consults currently assigned');

  // A new stroke consult at the hospital the engine reported as blocked (no credentialed physician routable).
  // If that hospital was not blocked, date the receipt past the warning threshold so the band still shows it.
  const consultId = nextId('CON');
  const receivedMs = current.nowMs - (c0.credentialedRoutableNow === 0 ? 30_000 : 6 * 60_000);
  await inject(request, `${nextId('EVT')},${iso(receivedMs)},,${consultId},consult_received,,${c0.hospitalId},Stroke consult request received`);
  await expect.poll(async () => (await getClock(request)).clock?.consultId ?? null).toBe(consultId);
  const after = await getClock(request);
  await expect(page.getByTestId('patient-clock-hospital')).toHaveText(after.clock?.hospitalName ?? '', { timeout: SSE_CYCLE_MS });
  await expect(page.getByTestId('patient-clock')).toHaveAttribute('data-consult-id', consultId, { timeout: SSE_CYCLE_MS });
  if (c0.credentialedRoutableNow === 0) await expect(page.getByTestId('patient-clock')).toHaveAttribute('data-severity', 'critical');
});

test('phone pages keep the band compact (details hidden at phone width)', async ({ browser, baseURL, request }) => {
  const p = await getClock(request);
  const ctx = await browser.newContext(device(baseURL, { width: 390, height: 844 }, true));
  const phone = await ctx.newPage();
  await phone.goto('/lead');
  await expect(phone.getByTestId('ai-banner')).toBeVisible();
  if (p.clock !== null) {
    await expect(phone.getByTestId('patient-clock-hospital')).toHaveText(p.clock.hospitalName);
    await expect(phone.getByTestId('patient-clock-failures')).toBeHidden();
    const box = await phone.getByTestId('patient-clock').boundingBox();
    expect(box?.height ?? 0).toBeLessThan(120);
  }
  const overflowX = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflowX).toBeLessThanOrEqual(1);
  // Physician-facing notification pages carry no clinical band (brief: no patient information in any notification).
  await phone.goto('/offer/not-a-real-offer?t=invalid');
  await expect(phone.getByTestId('ai-banner')).toBeVisible();
  await expect(phone.getByTestId('patient-clock')).toHaveCount(0);
  await expect(phone.getByTestId('patient-clock-clear')).toHaveCount(0);
  await ctx.close();
});
