import { guard, json } from '@/server/http';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/demo/reset: clears data/live, empties the action log, clock back to the reference instant, paused. */
export function POST(): Promise<Response> {
  return guard(async () => {
    const store = getStore();
    const clock = await store.reset();
    return json({ ok: true, clock, version: store.snapshot().version });
  });
}
