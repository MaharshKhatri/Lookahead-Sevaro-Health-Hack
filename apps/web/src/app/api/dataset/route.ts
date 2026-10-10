import type { IngestMapping } from '@lookahead/engine';
import { stageUpload } from '@/server/dataset';
import { guard, json } from '@/server/http';
import { StoreError, getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/dataset: the active dataset, the one Revert would restore, and the storage backend. */
export function GET(): Promise<Response> {
  return guard(async () => {
    const s = (await getReadyStore()).snapshot();
    return json({ active: s.datasetMeta, previous: s.previousMeta, store: s.storeKind, datasetVersion: s.datasetVersion });
  });
}

/**
 * POST /api/dataset (multipart/form-data): field "files" (one or more .csv,
 * or a .zip of them), optional field "mapping" (mapping.json text). Stages
 * the upload and returns the engine's ingest report plus the snapshot check.
 * Nothing changes until POST /api/dataset/activate.
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) throw new StoreError('BAD_REQUEST', 'send multipart/form-data with one or more "files"');
    const form = await req.formData();
    const files = await Promise.all(
      form
        .getAll('files')
        .filter((f): f is File => typeof f !== 'string')
        .map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const raw = form.get('mapping');
    let mapping: IngestMapping | null = null;
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        mapping = JSON.parse(raw) as IngestMapping;
      } catch (e) {
        throw new StoreError('BAD_REQUEST', `mapping is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return json(stageUpload(files, mapping));
  });
}
