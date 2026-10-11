import { ROLE_COOKIE, LEAD_COOKIE, clearCookie, clientKey, demoMode, isSessionRole, leadSetCookie, rolePinMatches, roleSetCookie, sessionRoles, SESSION_ROLES } from '@/server/auth';
import { errorJson, guard, json, readJson } from '@/server/http';
import { enforceRateLimit } from '@/server/ratelimit';
import { StoreError } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/auth/session: the roles this browser's cookies grant, and whether DEMO_MODE is on (D-91, OQ-52). */
export function GET(req: Request): Promise<Response> {
  return guard(() => json({ roles: [...sessionRoles(req)], demoMode: demoMode() }));
}

/**
 * POST /api/auth/session {role, pin}: sets the HttpOnly `lh_role` cookie
 * (12 h) when the PIN matches COORDINATOR_PIN / LEAD_PIN / ADMIN_PIN. The lead
 * role also sets the D-78 `lh_lead` cookie so both cookies keep working.
 * Rate limited (RATE_LIMIT_AUTH_PER_MIN, default 10/min per client).
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    enforceRateLimit('auth', clientKey(req));
    const b = await readJson(req);
    if (!isSessionRole(b.role)) throw new StoreError('BAD_REQUEST', `role must be one of ${SESSION_ROLES.join(', ')}`);
    if (!rolePinMatches(b.role, b.pin)) return errorJson('PIN_REQUIRED', 'wrong PIN', 401);
    const headers = new Headers({ 'set-cookie': roleSetCookie(b.role) });
    if (b.role === 'clinical_lead') headers.append('set-cookie', leadSetCookie());
    const res = json({ ok: true, role: b.role, demoMode: demoMode() });
    for (const [k, v] of headers) res.headers.append(k, v);
    return res;
  });
}

/** DELETE /api/auth/session: forget every role on this browser (both cookies). */
export function DELETE(): Promise<Response> {
  return guard(() => {
    const res = json({ ok: true, roles: [] });
    res.headers.append('set-cookie', clearCookie(ROLE_COOKIE));
    res.headers.append('set-cookie', clearCookie(LEAD_COOKIE));
    return res;
  });
}
