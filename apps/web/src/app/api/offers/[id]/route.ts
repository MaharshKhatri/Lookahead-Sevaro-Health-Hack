import { verifyOfferToken } from '@/server/auth';
import { errorJson, guard, json } from '@/server/http';
import { publicOffer } from '@/server/offers';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/offers/:id?t=<token>: the physician's phone view (delivered message only, PHI-guarded; token per OQ-44). */
export function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return guard(async () => {
    const { id } = await ctx.params;
    const offerId = decodeURIComponent(id);
    if (!verifyOfferToken(offerId, new URL(req.url).searchParams.get('t'))) return errorJson('BAD_TOKEN', 'this offer link is not valid');
    const offer = publicOffer((await getReadyStore()).snapshot(), offerId);
    return offer === null ? errorJson('UNKNOWN_OFFER', `no offer ${id}`) : json(offer);
  });
}
