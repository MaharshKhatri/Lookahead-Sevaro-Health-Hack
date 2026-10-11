import './helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mulberry32 } from '@lookahead/engine';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as stressRoute from '@/app/api/stress/route';
import type { ViewDTO } from '@/lib/dto';
import { resetRateLimits } from '@/server/ratelimit';
import { BREAK_IDS, type StressResult, type StressTotals, resetStressTotals } from '@/server/stress';
import { disposeStore, getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';
import { body, req } from './helpers';

/**
 * Property test for the stress harness (LOOKAHEAD-DEFINED): for 50 seeds,
 * reset the store, run the six break actions in a seeded random order
 * (mulberry32), and after every action assert the Command Center invariants:
 * the view computes, attention ranks are 1..n, coverage classes are within the
 * four brief classes, no consult is both assigned and unassigned, every action
 * is ok or a typed error, and totals.errors matches the failed results.
 */

const SEEDS = 50;
const CLASSES = new Set(['OK', 'AT_RISK', 'HARD_GAP', 'DEADLOCK']);

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function invariants(view: ViewDTO, where: string): void {
  expect(view.attention.map((a) => a.rank), where).toEqual(view.attention.map((_, i) => i + 1));
  for (const row of view.coverage.rows) {
    expect(CLASSES.has(row.worst), `${where} ${row.hospitalId} worst`).toBe(true);
    for (const c of row.cells) expect(CLASSES.has(c.class), `${where} ${row.hospitalId} ${c.startMs}`).toBe(true);
  }
  const ids = view.consults.map((c) => c.consultId);
  expect(new Set(ids).size, `${where} consult rows unique`).toBe(ids.length);
  const assigned = new Set(view.consults.filter((c) => c.assigned !== null).map((c) => c.consultId));
  const deadlocked = view.attention.filter((a) => a.kind === 'ROUTING_DEADLOCK').flatMap((a) => a.consultIds);
  for (const id of deadlocked) expect(assigned.has(id), `${where}: ${id} is assigned yet reported as an unassigned deadlock`).toBe(false);
  const holders = new Map<string, string>();
  for (const p of view.physicians) {
    for (const id of p.openConsultIds) {
      expect(holders.get(id) ?? p.physicianId, `${where}: ${id} open on two physicians`).toBe(p.physicianId);
      holders.set(id, p.physicianId);
    }
  }
}

const BATCH = 10;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('stress property: 50 seeds x the six break actions in seeded order', () => {
  let failed = 0;
  let runs = 0;
  beforeAll(() => {
    disposeStore();
    resetStressTotals();
  });
  afterAll(() => disposeStore());

  for (let from = 1; from <= SEEDS; from += BATCH) {
    it(
      `invariants hold after every action (seeds ${from}-${from + BATCH - 1})`,
      async () => {
        for (let seed = from; seed < from + BATCH; seed++) {
          resetRateLimits();
          expect((await resetRoute.POST(req('/api/demo/reset', { method: 'POST' }))).status).toBe(200);
          for (const action of shuffled(BREAK_IDS, seed)) {
            const where = `seed ${seed} ${action}`;
            const r = await stressRoute.POST(req('/api/stress', { method: 'POST', body: JSON.stringify({ action, seed }) }));
            expect(r.status, where).toBe(200);
            const b = await body<{ result: StressResult; totals: StressTotals }>(r);
            runs++;
            if (!b.result.ok) failed++;
            expect(b.result.ok || (typeof b.result.error === 'string' && b.result.error.length > 0), `${where}: ${b.result.summary}`).toBe(true);
            expect(b.totals.handled, where).toBe(runs);
            expect(b.totals.errors, where).toBe(failed);
            const snap = (await getReadyStore()).snapshot();
            let view: ViewDTO | null = null;
            expect(() => {
              view = computeView(snap);
            }, where).not.toThrow();
            if (view !== null) invariants(view, where);
            // Let vitest's worker RPC breathe between actions (the engine pass is synchronous).
            await yieldToLoop();
          }
        }
      },
      120_000,
    );
  }

  it('ran every seed and action', () => {
    expect(runs).toBe(SEEDS * BREAK_IDS.length);
  });
});
