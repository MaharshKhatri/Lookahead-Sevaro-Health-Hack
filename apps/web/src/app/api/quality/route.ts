import { errorJson, guard, json } from '@/server/http';
import { readBacktest } from '@/server/quality';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/quality: the forecast backtest report (docs/forecast_backtest.json, D-89); 404 when `pnpm report:forecast` has not been run. */
export function GET(): Promise<Response> {
  return guard(() => {
    const r = readBacktest();
    return r === null ? errorJson('NOT_FOUND', 'docs/forecast_backtest.json is missing; run `pnpm report:forecast`', 404) : json(r);
  });
}
