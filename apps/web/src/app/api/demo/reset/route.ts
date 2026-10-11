import { requireDemoControl } from '@/server/auth';
import { guard, json } from '@/server/http';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/demo/reset: clears data/live, empties the action log, clock back to
 * the reference instant, paused. D-91: open in DEMO_MODE, else a coordinator or
 * admin session (route tests call POST() without a request in DEMO_MODE).
 */
export function POST(req?: Request): Promise<Response> {
  return guard(async () => {
    requireDemoControl(req);
    const store = await getReadyStore();
    const clock = await store.reset();
    return json({ ok: true, clock, version: store.snapshot().version });
  });
}
