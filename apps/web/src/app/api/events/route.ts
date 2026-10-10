import { guard, json, readJson } from '@/server/http';
import { StoreError, getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/events: event_stream.csv rows (with or without the header) as
 * text/csv, or JSON {text}. Appended at the sim clock with no restart (brief
 * "What Teams Must Demonstrate" #8). Per-line results.
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    const type = req.headers.get('content-type') ?? '';
    const text = type.includes('application/json') ? (await readJson(req)).text : await req.text();
    if (typeof text !== 'string' || text.trim() === '') throw new StoreError('BAD_REQUEST', 'send event_stream.csv rows as text/csv or JSON {"text": "..."}');
    const r = await (await getReadyStore()).inject(text);
    return json({ ok: r.rejected.length === 0, ...r });
  });
}
