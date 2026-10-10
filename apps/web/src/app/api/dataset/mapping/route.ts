import type { IngestMapping } from '@lookahead/engine';
import { remapStage } from '@/server/dataset';
import { guard, json, readJson } from '@/server/http';
import { StoreError } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/dataset/mapping {stageId, mapping}: writes mapping.json into the staged upload and re-ingests (OQ-45). */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    const b = await readJson(req);
    if (typeof b.stageId !== 'string') throw new StoreError('BAD_REQUEST', 'stageId is required');
    if (typeof b.mapping !== 'object' || b.mapping === null) throw new StoreError('BAD_REQUEST', 'mapping must be an object');
    return json(remapStage(b.stageId, b.mapping as IngestMapping));
  });
}
