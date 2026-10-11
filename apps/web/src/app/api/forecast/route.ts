import { guard, json } from '@/server/http';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/forecast: the surge forecast at the sim clock (D-85), the same object /api/view carries. */
export function GET(): Promise<Response> {
  return guard(async () => json(computeView((await getReadyStore()).snapshot()).forecast));
}
