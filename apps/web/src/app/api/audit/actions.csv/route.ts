import { actionsCsv } from '@lookahead/engine';
import { guard } from '@/server/http';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/audit/actions.csv: one row per action event, every intervention
 * (split-shift offers, escalations, reassignment requests, internal alerts)
 * with who acted, in which role, and the approval state (D-88; brief "Users
 * and Decision Rights", "Log every offer ... who approved, and the outcome").
 */
export function GET(): Promise<Response> {
  return guard(async () => {
    const s = (await getReadyStore()).snapshot();
    return new Response(actionsCsv(s.log, s.clock.nowMs), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="lookahead-action-audit.csv"', 'cache-control': 'no-store' },
    });
  });
}
