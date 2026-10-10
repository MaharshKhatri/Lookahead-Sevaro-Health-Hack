import 'server-only';
import { ERROR_STATUS } from '@/lib/errors';
import { StoreError } from './store';

/**
 * Every route answers JSON, never a crash page (Session 6 spec): engine and
 * store error codes map to 4xx (lib/errors.ts), anything else is a 500 with
 * the message.
 */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export function errorJson(code: string, message: string, status?: number): Response {
  return json({ ok: false, code, message }, status ?? ERROR_STATUS[code] ?? 400);
}

export async function guard(fn: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StoreError) return errorJson(e.code, e.message);
    if (e instanceof SyntaxError) return errorJson('BAD_REQUEST', `invalid JSON: ${e.message}`);
    const message = e instanceof Error ? e.message : String(e);
    console.error('[lookahead] route error:', e);
    return errorJson('INTERNAL', message, 500);
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === '') return {};
  const v: unknown = JSON.parse(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new StoreError('BAD_REQUEST', 'body must be a JSON object');
  return v as Record<string, unknown>;
}

/** Origin of the current request (for QR links); LOOKAHEAD_PUBLIC_ORIGIN wins (e.g. a LAN address for phones). */
export function originOf(req: Request): string {
  const env = process.env.LOOKAHEAD_PUBLIC_ORIGIN;
  if (env !== undefined && env !== '') return env.replace(/\/$/, '');
  const h = req.headers;
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (host === null) return new URL(req.url).origin;
  const proto = h.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  return `${proto}://${host}`;
}
