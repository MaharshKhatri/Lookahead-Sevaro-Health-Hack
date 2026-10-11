import { errorJson, guard, json } from '@/server/http';
import { rewindFor } from '@/server/rewind';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/rewind: the engine's counterfactual replay of the day at the dataset's reference instant; 503 NOT_READY while the engine export is absent. */
export function GET(): Promise<Response> {
  return guard(async () => {
    const r = rewindFor((await getReadyStore()).snapshot());
    return r === null ? errorJson('NOT_READY', 'the engine does not export rewind() yet', 503) : json(r);
  });
}
