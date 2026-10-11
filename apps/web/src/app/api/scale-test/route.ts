import { guard, json } from '@/server/http';
import { SCALE_TEST_MAX_FACTOR, parseFactor, runScaleTest } from '@/server/scaleTest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * POST /api/scale-test[?scale=N]: runs the scale bench (x20 by default) in an
 * isolated child process and returns measured per-stage timings for x1 and xN
 * (sprint B3). 409 while another run is in flight, 504 with the stage reached
 * on timeout, 503 when the runtime cannot run the bench.
 */
export async function POST(req: Request): Promise<Response> {
  return guard(async () => {
    const factor = parseFactor(new URL(req.url).searchParams.get('scale'));
    if (factor === null) return json({ ok: false, code: 'BAD_REQUEST', message: `scale must be an integer from 1 to ${SCALE_TEST_MAX_FACTOR}` }, 400);
    const r = await runScaleTest(factor);
    return json(r, r.ok ? 200 : r.status);
  });
}
