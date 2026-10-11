import { architectureReport } from '@/server/architecture';
import { guard, json } from '@/server/http';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/architecture: action-log counters and request-time badges (sprint A4); every value computed per request. */
export async function GET(): Promise<Response> {
  return guard(async () => json(architectureReport((await getReadyStore()).snapshot())));
}
