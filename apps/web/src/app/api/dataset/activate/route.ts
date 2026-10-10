import { requireLead } from '@/server/auth';
import { ingestStage, stagePath } from '@/server/dataset';
import { guard, json, readJson } from '@/server/http';
import { integritySummary } from '@/server/integrity';
import { StoreError, getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/dataset/activate {stageId}: swaps the store's dataset atomically
 * (new version, action log and injected rows cleared, clock at the new
 * snapshot instant or last event). The previous dataset is kept for Revert.
 * A snapshot mismatch does not block activation; it is reported.
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    requireLead(req);
    const b = await readJson(req);
    if (typeof b.stageId !== 'string') throw new StoreError('BAD_REQUEST', 'stageId is required');
    const staged = ingestStage(b.stageId);
    if (!staged.canActivate) throw new StoreError('BAD_DATASET', 'this upload does not ingest; fix the report first');
    const label = typeof b.label === 'string' && b.label.trim() !== '' ? b.label.trim().slice(0, 80) : `upload ${b.stageId.slice(0, 8)} (${staged.files.length} files)`;
    const store = await getReadyStore();
    const meta = await store.activate(stagePath(b.stageId), label);
    return json({ ok: true, active: meta, integrity: integritySummary(store.snapshot()), clock: store.snapshot().clock });
  });
}
