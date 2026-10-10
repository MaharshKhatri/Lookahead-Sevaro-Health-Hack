import { auditTrail } from '@lookahead/engine';
import { errorJson, guard, json } from '@/server/http';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/audit/:offerId: the engine's audit trail, built only from the frozen action log (D-60). */
export function GET(_req: Request, ctx: { params: Promise<{ offerId: string }> }): Promise<Response> {
  return guard(async () => {
    const { offerId } = await ctx.params;
    const s = (await getReadyStore()).snapshot();
    const trail = auditTrail(s.log, decodeURIComponent(offerId), s.clock.nowMs);
    return trail === null ? errorJson('UNKNOWN_OFFER', `no offer ${offerId}`) : json(trail);
  });
}
