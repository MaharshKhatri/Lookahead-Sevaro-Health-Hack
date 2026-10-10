import { auditCsv } from '@lookahead/engine';
import { guard } from '@/server/http';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/audit.csv: one row per offer, 27 pinned columns (D-60). */
export function GET(): Promise<Response> {
  return guard(() => {
    const s = getStore().snapshot();
    return new Response(auditCsv(s.log, s.clock.nowMs), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="lookahead-offer-audit.csv"', 'cache-control': 'no-store' },
    });
  });
}
