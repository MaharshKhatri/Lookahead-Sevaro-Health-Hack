import { LEAD_COOKIE, isLead, leadSetCookie, pinMatches } from '@/server/auth';
import { errorJson, guard, json, readJson } from '@/server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/auth/lead: whether this browser holds the clinical-lead PIN cookie (OQ-44). */
export function GET(req: Request): Promise<Response> {
  return guard(() => json({ lead: isLead(req) }));
}

/** POST /api/auth/lead {pin}: sets the HttpOnly lead cookie when the PIN matches LEAD_PIN. */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    const b = await readJson(req);
    if (!pinMatches(b.pin)) return errorJson('PIN_REQUIRED', 'wrong PIN', 401);
    return json({ ok: true, lead: true }, 200, { 'set-cookie': leadSetCookie() });
  });
}

/** DELETE /api/auth/lead: forget the PIN on this browser. */
export function DELETE(): Promise<Response> {
  return guard(() => json({ ok: true, lead: false }, 200, { 'set-cookie': `${LEAD_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` }));
}
