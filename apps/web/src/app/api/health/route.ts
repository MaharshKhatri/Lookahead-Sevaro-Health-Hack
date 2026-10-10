import { guard, json } from '@/server/http';
import { getNarrator } from '@/server/narrate/bedrock';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/health: {ok, store, bedrock, datasetVersion, clock}: what a deploy check or the runbook looks at. */
export function GET(): Promise<Response> {
  return guard(async () => {
    const store = await getReadyStore();
    const s = store.snapshot();
    const b = await getNarrator().status();
    return json({
      ok: true,
      store: s.storeKind,
      bedrock: b.available ? 'available' : 'unavailable',
      bedrockModel: b.modelId,
      bedrockReason: b.reason,
      dataset: { key: s.datasetMeta.key, label: s.datasetMeta.label, source: s.datasetMeta.source, events: s.dataset.events.length },
      datasetVersion: s.datasetVersion,
      version: s.version,
      clock: s.clock,
      logSeq: s.log.at(-1)?.seq ?? 0,
      conflictsResolved: store.conflictsResolved,
      bootWarnings: store.bootWarnings,
      publicOrigin: process.env.LOOKAHEAD_PUBLIC_ORIGIN ?? null,
    });
  });
}
