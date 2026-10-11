import { requireDemoControl } from '@/server/auth';
import { guard, json, readJson } from '@/server/http';
import { STRESS_ACTIONS, runStress, stressTotals } from '@/server/stress';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/stress: the stress actions (prove it / break it) and the run totals since boot.
 * POST /api/stress {action, seed?}: runs one action through the real ingest and
 * command routes and answers 200 {result, totals}; an action that fails is
 * ok:false inside the result (never a 500). Unknown action -> 400 BAD_REQUEST.
 * Mutates the live store, so it is a demo control (open in DEMO_MODE, D-91).
 */
export function GET(): Promise<Response> {
  return guard(() => json({ actions: STRESS_ACTIONS, totals: stressTotals() }));
}

export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    requireDemoControl(req);
    const body = await readJson(req);
    return json(await runStress(body.action, body.seed));
  });
}
