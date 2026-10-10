import { requireLead } from '@/server/auth';
import { guard, json } from '@/server/http';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/dataset/revert: one-click back to the previously active dataset (fresh run). */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    requireLead(req);
    const store = await getReadyStore();
    const meta = await store.revert();
    return json({ ok: true, active: meta, previous: store.snapshot().previousMeta });
  });
}
