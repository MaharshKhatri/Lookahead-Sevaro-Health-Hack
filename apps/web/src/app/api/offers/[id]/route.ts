import { errorJson, guard, json } from '@/server/http';
import { publicOffer } from '@/server/offers';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/offers/:id: the physician's phone view (delivered message only, PHI-guarded). */
export function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return guard(async () => {
    const { id } = await ctx.params;
    const offer = publicOffer(getStore().snapshot(), decodeURIComponent(id));
    return offer === null ? errorJson('UNKNOWN_OFFER', `no offer ${id}`) : json(offer);
  });
}
