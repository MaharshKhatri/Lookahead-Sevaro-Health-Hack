import { guard, json } from '@/server/http';
import { getReadyStore } from '@/server/store';
import { v1Standby, requireApiRead } from '@/server/v1';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/v1/standby (D-96): versioned read model (schemaVersion "1.0") at the sim clock; open in DEMO_MODE, else LOOKAHEAD_API_KEY. */
export function GET(req: Request): Promise<Response> {
  return guard(async () => {
    requireApiRead(req);
    return json(v1Standby(computeView((await getReadyStore()).snapshot())));
  });
}
