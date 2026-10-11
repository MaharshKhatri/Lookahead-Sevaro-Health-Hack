import { clientKey } from '@/server/auth';
import { guard, json } from '@/server/http';
import { enforceRateLimit } from '@/server/ratelimit';
import { StoreError, getReadyStore } from '@/server/store';
import { SIGNATURE_HEADER, bodyToCsv, ingestReport, verifySignature } from '@/server/v1';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/v1/events (D-96): Sevaro event rows pushed by an integration.
 * Body: event_stream.csv text (text/csv, header optional) or JSON (an array
 * of objects keyed by the CSV columns, or {events: [...]}). Signature:
 * `x-lookahead-signature: sha256=<hex HMAC-SHA256(LOOKAHEAD_INGEST_SECRET, raw body)>`.
 * Idempotent: a row whose event_id is already known is reported as a
 * duplicate, never appended twice (OQ-04). Rate limited with the events bucket.
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    enforceRateLimit('events', clientKey(req));
    const raw = await req.text();
    const signature = verifySignature(raw, req.headers.get(SIGNATURE_HEADER));
    if (raw.trim() === '') throw new StoreError('BAD_REQUEST', 'empty body: send event rows as text/csv or a JSON array');
    const { text, format } = bodyToCsv(raw, req.headers.get('content-type') ?? '');
    const r = await (await getReadyStore()).inject(text);
    const report = ingestReport(r, signature, format);
    return json(report, report.ok ? 200 : 207);
  });
}
