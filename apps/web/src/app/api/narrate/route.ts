import { guard, json, readJson, errorJson } from '@/server/http';
import { narrate, type NarrationKind } from '@/server/narrate';
import { StoreError, getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS: readonly NarrationKind[] = ['attention', 'recommendation', 'lead_briefing'];

/**
 * POST /api/narrate {kind, id} -> {text, source: 'bedrock'|'template', checks}.
 * kind attention: id = attention item id; recommendation: id = the top
 * issue's attention id (or "top"); lead_briefing: id = offer id. Narration is
 * never a decision (CLAUDE.md: LLMs only narrate engine-computed facts).
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    const b = await readJson(req);
    if (typeof b.kind !== 'string' || !KINDS.includes(b.kind as NarrationKind)) throw new StoreError('BAD_REQUEST', `kind must be one of ${KINDS.join(', ')}`);
    if (typeof b.id !== 'string' || b.id === '') throw new StoreError('BAD_REQUEST', 'id is required');
    const s = (await getReadyStore()).snapshot();
    const n = await narrate(computeView(s), s.datasetVersion, b.kind as NarrationKind, b.id);
    if (n === null) return errorJson('NOT_FOUND', `nothing to narrate for ${b.kind} ${b.id} at this instant`);
    return json({ text: n.text, source: n.source, checks: n.checks, modelId: n.modelId, fallbackReason: n.fallbackReason });
  });
}
