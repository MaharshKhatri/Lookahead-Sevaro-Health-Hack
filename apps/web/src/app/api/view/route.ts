import { guard, json, originOf } from '@/server/http';
import { qrSvg } from '@/server/qr';
import { getStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/view: the whole Command Center state at the sim clock (memoized per version). */
export function GET(req: Request): Promise<Response> {
  return guard(async () => {
    const view = computeView(getStore().snapshot());
    // QR codes depend on the requesting host, so they are added outside the memo.
    const origin = originOf(req);
    const qr: Record<string, { url: string; svg: string }> = {};
    for (const o of view.offers.filter((x) => x.status === 'delivered')) {
      const url = `${origin}${o.offerPath}`;
      qr[o.offerId] = { url, svg: await qrSvg(url) };
    }
    return json({ ...view, qr });
  });
}
