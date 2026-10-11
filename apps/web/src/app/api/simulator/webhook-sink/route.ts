import { guard, json } from '@/server/http';
import { recordSinkDelivery, requireSimulator, sinkEntries } from '@/server/simulator';
import { SIGNATURE_HEADER } from '@/server/v1';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY_CHARS = 64 * 1024;

/**
 * Dev webhook sink (sprint B1, demo only): the outbound dispatcher's default
 * target while the simulator is on and LOOKAHEAD_WEBHOOK_URL is unset.
 * POST verifies x-lookahead-signature against the webhook secret when one is
 * configured and stores {receivedAtMs, verified, body} (last 50); a bad
 * signature is stored as verified:false and answered 401. GET lists them,
 * newest first. 404 when the simulator is disabled.
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    requireSimulator();
    const raw = (await req.text()).slice(0, MAX_BODY_CHARS);
    const entry = recordSinkDelivery(raw, req.headers.get(SIGNATURE_HEADER), Date.now());
    return json({ ok: entry.verified !== false, verified: entry.verified }, entry.verified === false ? 401 : 200);
  });
}

export function GET(): Promise<Response> {
  return guard(() => {
    requireSimulator();
    return json({ entries: sinkEntries() });
  });
}
