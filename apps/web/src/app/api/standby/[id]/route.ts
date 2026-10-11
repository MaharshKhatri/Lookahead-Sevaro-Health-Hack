import { verifyStandbyToken } from '@/server/auth';
import { errorJson, guard, json } from '@/server/http';
import { publicStandby } from '@/server/standby';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/standby/:id?t=<token>: the physician's phone view of a standby (delivered texts only, PHI-guarded; token per OQ-44). */
export function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return guard(async () => {
    const { id } = await ctx.params;
    const standbyId = decodeURIComponent(id);
    if (!verifyStandbyToken(standbyId, new URL(req.url).searchParams.get('t'))) return errorJson('BAD_TOKEN', 'this standby link is not valid');
    const sb = publicStandby((await getReadyStore()).snapshot(), standbyId);
    return sb === null ? errorJson('UNKNOWN_STANDBY', `no standby ${id}`, 404) : json(sb);
  });
}
