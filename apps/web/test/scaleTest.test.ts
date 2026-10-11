import { req } from './helpers';
import { afterEach, describe, expect, it } from 'vitest';
import * as scaleRoute from '@/app/api/scale-test/route';
import type { ScaleTestFailure, ScaleTestOk } from '@/server/scaleTest';

/**
 * Live scale test (sprint B3): the bench runs in a child process; numbers are
 * measured, the 1 s claim is made only for stages measured under 1 s, and a
 * timeout is a loud 504 naming the stage reached.
 */

const post = (q = '') => scaleRoute.POST(req(`/api/scale-test${q}`, { method: 'POST' }));

afterEach(() => {
  delete process.env.SCALE_TEST_TIMEOUT_MS;
  delete process.env.SCALE_TEST_TSX_LOADER;
});

describe('POST /api/scale-test', () => {
  it('?scale=2 returns measured x1 and x2 timings side by side', async () => {
    const r = await post('?scale=2');
    expect(r.status).toBe(200);
    const b = (await r.json()) as ScaleTestOk;
    expect(b.ok).toBe(true);
    expect(b.factor).toBe(2);
    expect(b.bench.repeats).toBe(1);
    expect(b.bench.scaled.hospitals).toBe(2 * b.bench.baseline.hospitals);
    expect(b.bench.scaled.events).toBe(2 * b.bench.baseline.events);
    expect(b.stages.length).toBeGreaterThan(4);
    for (const s of b.stages.filter((x) => x.xNMs !== null)) {
      expect(Number.isFinite(s.xNMs)).toBe(true);
      expect(s.xNMs).toBeGreaterThan(0);
      expect(Number.isFinite(s.x1Ms)).toBe(true);
      // The words follow the number: "under 1 s" only when measured under 1000 ms.
      expect(s.underBudget).toBe((s.xNMs ?? Infinity) < 1000);
      expect(s.sentence.includes('under 1 s')).toBe(s.underBudget);
    }
    expect(b.stages.map((s) => s.stage)).toContain('decide');
    expect(b.summary).toContain(`x2: ${b.bench.scaled.hospitals} hospitals`);
  }, 60_000);

  it('a tiny SCALE_TEST_TIMEOUT_MS fails loudly with 504 and the stage reached', async () => {
    process.env.SCALE_TEST_TIMEOUT_MS = '50';
    const r = await post('?scale=2');
    expect(r.status).toBe(504);
    const b = (await r.json()) as ScaleTestFailure;
    expect(b).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(b.message).toContain('exceeded 50 ms');
    expect(b.message).toMatch(/before the first stage started|stage "/);
  }, 30_000);

  it('concurrent runs: the second answers 409 BUSY', async () => {
    const first = post('?scale=1');
    const second = await post('?scale=1');
    expect(second.status).toBe(409);
    expect(((await second.json()) as ScaleTestFailure).code).toBe('BUSY');
    expect((await first).status).toBe(200);
  }, 60_000);

  it('no tsx loader at runtime: 503 with an honest message; bad scale: 400', async () => {
    process.env.SCALE_TEST_TSX_LOADER = '/nonexistent/tsx/loader.mjs';
    const r = await post('?scale=2');
    expect(r.status).toBe(503);
    expect(((await r.json()) as ScaleTestFailure).message).toContain('tsx loader is not installed');
    delete process.env.SCALE_TEST_TSX_LOADER;
    expect((await post('?scale=0')).status).toBe(400);
    expect((await post('?scale=abc')).status).toBe(400);
  });
});
