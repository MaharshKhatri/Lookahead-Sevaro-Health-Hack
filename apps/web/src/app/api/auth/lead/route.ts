import { LEAD_COOKIE, clearCookie, clientKey, isLead, leadSetCookie, pinMatches } from '@/server/auth';
import { errorJson, guard, json, readJson } from '@/server/http';
import { enforceRateLimit } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/auth/lead: whether this browser holds the clinical-lead role (the D-78 `lh_lead` cookie or a D-91 `lh_role` session). */
export function GET(req: Request): Promise<Response> {
  return guard(() => json({ lead: isLead(req) }));
}

/** POST /api/auth/lead {pin}: sets the HttpOnly lead cookie when the PIN matches LEAD_PIN. Rate limited (D-91). */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    enforceRateLimit('auth', clientKey(req));
    const b = await readJson(req);
    if (!pinMatches(b.pin)) return errorJson('PIN_REQUIRED', 'wrong PIN', 401);
    return json({ ok: true, lead: true }, 200, { 'set-cookie': leadSetCookie() });
  });
}

/** DELETE /api/auth/lead: forget the PIN on this browser. */
export function DELETE(): Promise<Response> {
  return guard(() => json({ ok: true, lead: false }, 200, { 'set-cookie': clearCookie(LEAD_COOKIE) }));
}
