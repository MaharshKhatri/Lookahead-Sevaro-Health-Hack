import { guard, json } from '@/server/http';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/standby: the standby plan (D-90) and every standby folded from the action log, as /api/view carries them. */
export function GET(): Promise<Response> {
  return guard(async () => json(computeView((await getReadyStore()).snapshot()).standby));
}
