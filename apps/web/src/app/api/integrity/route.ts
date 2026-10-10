import { guard, json } from '@/server/http';
import { integrityReport } from '@/server/integrity';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/integrity: correct vs naive replay against the reference snapshot, late-event corrections, slider samples. */
export function GET(): Promise<Response> {
  return guard(async () => json(integrityReport((await getReadyStore()).snapshot())));
}
