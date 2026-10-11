import './helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as stressRoute from '@/app/api/stress/route';
import { resetRateLimits } from '@/server/ratelimit';
import { BREAK_IDS, STRESS_ACTIONS, type StressResult, type StressTotals, resetStressTotals } from '@/server/stress';
import { disposeStore, getReadyStore } from '@/server/store';
import { body, req } from './helpers';

/**
 * Stress harness (LOOKAHEAD-DEFINED): every action runs once through
 * POST /api/stress on the reference package, in contract order, against one
 * store. Expectations are derived from the responses and the store, never
 * from hard-coded ids or counts.
 */

const post = (payload: unknown) => stressRoute.POST(req('/api/stress', { method: 'POST', body: JSON.stringify(payload) }));
const alerts = async () => (await getReadyStore()).snapshot().log.filter((e) => e.type === 'internal_alert_sent').length;

describe('GET /api/stress', () => {
  it('lists the 13 actions in the contract (7 prove, 6 break) with totals', async () => {
    const r = await stressRoute.GET();
    expect(r.status).toBe(200);
    const b = await body<{ actions: { id: string; group: string; label: string; description: string }[]; totals: StressTotals }>(r);
    expect(b.actions.map((a) => a.id)).toEqual([
      'late_event', 'duplicate_flood', 'deadlock_recovery', 'trap_proof', 'generalization', 'deterministic_forecast', 'no_phi',
      'standby_declines', 'second_stroke_surge', 'heartbeat_lost', 'status_flap', 'stroke_no_credentialed', 'random_chaos',
    ]);
    expect(b.actions.filter((a) => a.group === 'break').map((a) => a.id)).toEqual([...BREAK_IDS]);
    for (const a of b.actions) expect(a.label.length * a.description.length).toBeGreaterThan(0);
    expect(typeof b.totals.handled).toBe('number');
  });
});

describe('POST /api/stress runs every action once through the real routes', () => {
  beforeAll(async () => {
    disposeStore();
    resetRateLimits();
    resetStressTotals();
    await resetRoute.POST(req('/api/demo/reset', { method: 'POST' }));
  });
  afterAll(() => disposeStore());

  it('unknown action is a 400 BAD_REQUEST', async () => {
    const r = await post({ action: 'not_an_action' });
    expect(r.status).toBe(400);
    expect((await body<{ code: string }>(r)).code).toBe('BAD_REQUEST');
  });

  for (const def of STRESS_ACTIONS) {
    it(`${def.id}: 200, ok, numeric latency, computed summary, one internal alert appended`, async () => {
      const keyBefore = (await getReadyStore()).snapshot().datasetMeta.key;
      const alertsBefore = await alerts();
      const r = await post({ action: def.id, seed: 7 });
      expect(r.status).toBe(200);
      const b = await body<{ result: StressResult; totals: StressTotals }>(r);
      expect(b.result.error, b.result.summary).toBeNull();
      expect(b.result.ok, b.result.summary).toBe(true);
      expect(b.result.action).toBe(def.id);
      expect(b.result.group).toBe(def.group);
      expect(Number.isFinite(b.result.latencyMs)).toBe(true);
      expect(b.result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(b.result.summary.trim().length).toBeGreaterThan(0);
      expect(b.totals.byAction[def.id]).toBe(1);
      expect(await alerts()).toBe(alertsBefore + 1);
      const s = (await getReadyStore()).snapshot();
      const alert = s.log.filter((e) => e.type === 'internal_alert_sent').at(-1);
      expect(alert?.type === 'internal_alert_sent' && alert.payload.automated).toBe(true);
      expect(alert?.type === 'internal_alert_sent' && alert.payload.physicianIds).toEqual([]);
      expect(alert?.type === 'internal_alert_sent' && alert.payload.message.startsWith('Stress test: ')).toBe(true);
      // generalization (and every other action) never swaps the live dataset.
      expect(s.datasetMeta.key).toBe(keyBefore);
      if (def.id === 'duplicate_flood') expect(b.result.metrics.ignored).toBe(10);
      if (def.id === 'deterministic_forecast') expect(b.result.metrics.distinctHashes).toBe(1);
      if (def.id === 'no_phi') expect(b.result.metrics.fail).toBe(0);
      // Resilience budget: well under 2 s per action on the reference data.
      expect(b.result.latencyMs).toBeLessThan(2_000);
    });
  }

  it('totals count every run and no errors', async () => {
    const b = await body<{ totals: StressTotals }>(await stressRoute.GET());
    expect(b.totals.handled).toBe(STRESS_ACTIONS.length + 0);
    expect(b.totals.errors).toBe(0);
    expect(b.totals.seconds).toBeGreaterThan(0);
  });
});

describe('POST /api/stress with LOOKAHEAD_INGEST_SECRET set signs its pushes', () => {
  beforeAll(async () => {
    disposeStore();
    resetRateLimits();
    process.env.LOOKAHEAD_INGEST_SECRET = 'stress-test-secret';
    await resetRoute.POST(req('/api/demo/reset', { method: 'POST' }));
  });
  afterAll(() => {
    delete process.env.LOOKAHEAD_INGEST_SECRET;
    disposeStore();
  });

  it('late_event is accepted with a verified HMAC signature', async () => {
    const b = await body<{ result: StressResult }>(await post({ action: 'late_event' }));
    expect(b.result.ok, b.result.summary).toBe(true);
    expect(b.result.details.some((d) => d.includes('signature verified'))).toBe(true);
  });

  it('a non-integer seed is a 400', async () => {
    const r = await post({ action: 'random_chaos', seed: 'x' });
    expect(r.status).toBe(400);
  });
});
