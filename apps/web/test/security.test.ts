import { body, lastStreamRow, req } from './helpers';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import { DATA_DIR } from './helpers';
import * as leadAuthRoute from '@/app/api/auth/lead/route';
import * as sessionRoute from '@/app/api/auth/session/route';
import * as clockRoute from '@/app/api/clock/route';
import * as commandsRoute from '@/app/api/commands/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as eventsRoute from '@/app/api/events/route';
import * as viewRoute from '@/app/api/view/route';
import type { CommandResponse, ViewDTO } from '@/lib/dto';
import { securityHeaders } from '../next.config';
import { LEAD_COOKIE, ROLE_COOKIE, demoMode, leadCookieValue, offerToken, parseRoleSession, roleSessionValue } from '@/server/auth';
import { resetRateLimits } from '@/server/ratelimit';
import { disposeStore } from '@/server/store';

/**
 * Security hardening (D-91, OQ-44 / OQ-52). DEMO_MODE stays on for every
 * other test file; here it is flipped per test through process.env, which
 * auth.ts reads on each call.
 */

const engineAt1820 = (() => {
  const ds = loadDataset(DATA_DIR);
  return decide(ds, snapshotAsOfMs(ds) ?? 0);
})();
const topPhysician = () => engineAt1820.recommendedOffer?.physicianId ?? '';

const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));
const leadCookie = () => `${LEAD_COOKIE}=${encodeURIComponent(leadCookieValue())}`;
const roleCookie = (value: string) => `${ROLE_COOKIE}=${encodeURIComponent(value)}`;
const command = (role: string, cmd: Record<string, unknown>, opts: { cookie?: string; actorId?: string; token?: string; headers?: Record<string, string> } = {}) =>
  commandsRoute.POST(
    req('/api/commands', {
      method: 'POST',
      role,
      ...(opts.actorId === undefined ? {} : { actorId: opts.actorId }),
      ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
      ...(opts.headers === undefined ? {} : { headers: opts.headers }),
      body: JSON.stringify({ command: cmd, ...(opts.token === undefined ? {} : { token: opts.token }) }),
    }),
  );
const session = (b: Record<string, unknown>, headers: Record<string, string> = {}) => sessionRoute.POST(req('/api/auth/session', { method: 'POST', headers, body: JSON.stringify(b) }));

async function proposeTop(commandId = 'sec-propose'): Promise<string> {
  const r = await command('coordinator', { type: 'proposeOffer', physicianId: topPhysician(), commandId });
  expect(r.status).toBe(200);
  const b = await body<CommandResponse & { emitted: { offerId?: string }[] }>(r);
  return b.emitted[0]?.offerId ?? '';
}

beforeEach(async () => {
  delete process.env.DEMO_MODE;
  resetRateLimits();
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterEach(() => {
  delete process.env.DEMO_MODE;
  resetRateLimits();
});
afterAll(() => disposeStore());

describe('decision rights are enforced server-side before the store (brief "Users and Decision Rights")', () => {
  it('coordinator approveOffer and physician proposeOffer are 403 FORBIDDEN_ROLE; the log is untouched', async () => {
    const offerId = await proposeTop();
    const before = (await view()).logSeq;
    const a = await command('coordinator', { type: 'approveOffer', offerId });
    expect(a.status).toBe(403);
    expect((await body(a)).code).toBe('FORBIDDEN_ROLE');
    const p = await command('physician', { type: 'proposeOffer', physicianId: topPhysician() }, { actorId: topPhysician() });
    expect(p.status).toBe(403);
    expect((await body(p)).code).toBe('FORBIDDEN_ROLE');
    // A lead with the PIN still may not propose: the check is on the command type, not on the credential.
    const l = await command('clinical_lead', { type: 'proposeOffer', physicianId: topPhysician() }, { cookie: leadCookie() });
    expect(l.status).toBe(403);
    expect((await view()).logSeq).toBe(before);
  });

  it('"system" is refused from clients (403)', async () => {
    const r = commandsRoute.POST(req('/api/commands', { method: 'POST', role: 'system', body: JSON.stringify({ command: { type: 'tick' } }) }));
    expect((await r).status).toBe(403);
  });
});

describe('offer link tokens (D-78)', () => {
  it('a token with one character changed is 403 BAD_TOKEN', async () => {
    const offerId = await proposeTop();
    expect((await command('clinical_lead', { type: 'approveOffer', offerId }, { cookie: leadCookie() })).status).toBe(200);
    const good = offerToken(offerId);
    const flipped = (good[0] === 'A' ? 'B' : 'A') + good.slice(1);
    expect(flipped).not.toBe(good);
    const r = await command('physician', { type: 'respond', offerId, response: 'accept' }, { actorId: topPhysician(), token: flipped });
    expect(r.status).toBe(403);
    expect((await body(r)).code).toBe('BAD_TOKEN');
    expect((await view()).offers[0]?.status).toBe('delivered');
  });
});

describe('role sessions (D-91, OQ-52)', () => {
  it('DEMO_MODE defaults to on: coordinator commands need no cookie, the lead still needs the PIN', async () => {
    expect(demoMode()).toBe(true);
    const offerId = await proposeTop();
    const noPin = await command('clinical_lead', { type: 'approveOffer', offerId });
    expect(noPin.status).toBe(401);
    expect((await body(noPin)).code).toBe('PIN_REQUIRED');
    const s = await body<{ roles: string[]; demoMode: boolean }>(await sessionRoute.GET(req('/api/auth/session')));
    expect(s).toEqual({ roles: [], demoMode: true });
  });

  it('POST /api/auth/session sets a signed cookie; GET reports the roles; a forged or tampered cookie grants nothing', async () => {
    const wrong = await session({ role: 'coordinator', pin: '0000' });
    expect(wrong.status).toBe(401);
    const ok = await session({ role: 'coordinator', pin: '1234' });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^lh_role=coordinator\.\d+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    const value = decodeURIComponent(setCookie.split(';')[0]?.slice('lh_role='.length) ?? '');
    expect(parseRoleSession(value, Date.now())).toBe('coordinator');
    const s = await body<{ roles: string[] }>(await sessionRoute.GET(req('/api/auth/session', { cookie: roleCookie(value) })));
    expect(s.roles).toEqual(['coordinator']);
    // Tampered tag, wrong role in the clear, expired, garbage: all null.
    const [role, exp, tag] = value.split('.');
    expect(parseRoleSession(`${role}.${exp}.${(tag?.[0] === 'A' ? 'B' : 'A') + (tag?.slice(1) ?? '')}`, Date.now())).toBeNull();
    expect(parseRoleSession(`admin.${exp}.${tag}`, Date.now())).toBeNull();
    expect(parseRoleSession(value, Number(exp) + 1)).toBeNull();
    expect(parseRoleSession('coordinator.forged', Date.now())).toBeNull();
    expect(parseRoleSession(roleSessionValue('admin', Date.now() + 60_000), Date.now())).toBe('admin');
    // The lead role through the session endpoint also sets the D-78 lh_lead cookie.
    const lead = await session({ role: 'clinical_lead', pin: '2026' });
    expect(lead.headers.getSetCookie().map((c) => c.split('=')[0]).sort()).toEqual([LEAD_COOKIE, ROLE_COOKIE]);
  });

  it('DEMO_MODE=false: every command needs a session granting the header role (401 ROLE_SESSION_REQUIRED); a forged cookie is refused', async () => {
    const offerId = await proposeTop();
    process.env.DEMO_MODE = 'false';
    const none = await command('coordinator', { type: 'proposeOffer', physicianId: topPhysician(), commandId: 'sec-2' });
    expect(none.status).toBe(401);
    expect((await body(none)).code).toBe('ROLE_SESSION_REQUIRED');
    const forged = await command('coordinator', { type: 'proposeOffer', physicianId: topPhysician(), commandId: 'sec-3' }, { cookie: roleCookie('coordinator.99999999999999.forgedforgedforgedforgedforged12') });
    expect(forged.status).toBe(401);
    // A lead cookie does not grant coordinator rights (the header must match a role the cookie grants).
    const asLeadCookie = await command('coordinator', { type: 'proposeOffer', physicianId: topPhysician(), commandId: 'sec-4' }, { cookie: leadCookie() });
    expect(asLeadCookie.status).toBe(401);
    // The lead's missing session is also ROLE_SESSION_REQUIRED outside DEMO_MODE.
    const leadNoCookie = await command('clinical_lead', { type: 'approveOffer', offerId });
    expect(leadNoCookie.status).toBe(401);
    expect((await body(leadNoCookie)).code).toBe('ROLE_SESSION_REQUIRED');
    // A real session works; the admin session implies coordinator.
    const good = roleCookie(roleSessionValue('coordinator', Date.now() + 60_000));
    const sent = await command('coordinator', { type: 'cancelOffer', offerId, reason: 'test' }, { cookie: good });
    expect(sent.status).toBe(200);
    const admin = roleCookie(roleSessionValue('admin', Date.now() + 60_000));
    const asAdmin = await command('coordinator', { type: 'proposeOffer', physicianId: topPhysician(), commandId: 'sec-5' }, { cookie: admin });
    expect(asAdmin.status).toBe(200);
    // Demo controls need a coordinator/admin session too.
    expect((await clockRoute.POST(req('/api/clock', { method: 'POST', body: JSON.stringify({ action: 'pause' }) }))).status).toBe(401);
    expect((await clockRoute.POST(req('/api/clock', { method: 'POST', cookie: good, body: JSON.stringify({ action: 'pause' }) }))).status).toBe(200);
    expect((await eventsRoute.POST(req('/api/events', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: lastStreamRow() }))).status).toBe(401);
    expect((await resetRoute.POST(req('/api/demo/reset', { method: 'POST' }))).status).toBe(401);
    expect((await resetRoute.POST(req('/api/demo/reset', { method: 'POST', cookie: admin }))).status).toBe(200);
  });
});

describe('replayed injection and rate limits', () => {
  it('the same row injected twice: the second call reports duplicates=1, accepted=0', async () => {
    const v = await view();
    const [e1] = v.sample.nextEventIds;
    const row = `${e1},2026-03-17T18:20:00-04:00,,${v.sample.nextConsultId},consult_received,,${v.sample.surgingHospitalId},Stroke consult request received`;
    const post = () => eventsRoute.POST(req('/api/events', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: row }));
    const first = await body<{ accepted: unknown[]; duplicates: unknown[] }>(await post());
    expect(first.accepted).toHaveLength(1);
    expect(first.duplicates).toHaveLength(0);
    const second = await body<{ accepted: unknown[]; duplicates: { eventId: string }[] }>(await post());
    expect(second.accepted).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0]?.eventId).toBe(e1);
    expect((await view()).integrity.appendedCount).toBe(1);
  });

  it('POST /api/auth/* is limited per client: the 11th wrong PIN in a minute is 429 RATE_LIMITED, another client is not affected', async () => {
    const from = (ip: string) => ({ 'x-forwarded-for': `${ip}, 10.0.0.1` });
    for (let i = 0; i < 10; i++) expect((await session({ role: 'coordinator', pin: 'nope' }, from('203.0.113.9'))).status).toBe(401);
    const limited = await session({ role: 'coordinator', pin: '1234' }, from('203.0.113.9'));
    expect(limited.status).toBe(429);
    expect((await body(limited)).code).toBe('RATE_LIMITED');
    expect((await leadAuthRoute.POST(req('/api/auth/lead', { method: 'POST', headers: from('203.0.113.9'), body: JSON.stringify({ pin: '2026' }) }))).status).toBe(429);
    expect((await session({ role: 'coordinator', pin: '1234' }, from('203.0.113.10'))).status).toBe(200);
  });

  it('physician commands are limited (RATE_LIMIT_PHYSICIAN_PER_MIN) and injection too (RATE_LIMIT_EVENTS_PER_MIN)', async () => {
    process.env.RATE_LIMIT_PHYSICIAN_PER_MIN = '3';
    process.env.RATE_LIMIT_EVENTS_PER_MIN = '2';
    try {
      const offerId = await proposeTop();
      expect((await command('clinical_lead', { type: 'approveOffer', offerId }, { cookie: leadCookie() })).status).toBe(200);
      const bad = () => command('physician', { type: 'respond', offerId, response: 'accept' }, { actorId: topPhysician(), token: 'wrong' });
      for (let i = 0; i < 3; i++) expect((await bad()).status).toBe(403);
      const r = await bad();
      expect(r.status).toBe(429);
      expect((await body(r)).code).toBe('RATE_LIMITED');
      const inject = () => eventsRoute.POST(req('/api/events', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: lastStreamRow() }));
      expect((await inject()).status).toBe(200);
      expect((await inject()).status).toBe(200);
      expect((await inject()).status).toBe(429);
    } finally {
      delete process.env.RATE_LIMIT_PHYSICIAN_PER_MIN;
      delete process.env.RATE_LIMIT_EVENTS_PER_MIN;
    }
  });
});

describe('security headers (next.config.ts)', () => {
  it('CSP, nosniff, referrer and permissions policies on every path; /embed/* adds LOOKAHEAD_EMBED_ORIGINS to frame-ancestors; no X-Frame-Options', () => {
    const rules = securityHeaders('https://partner.example https://ops.example.org not-an-origin');
    const all = rules.find((r) => r.source === '/:path*');
    const embed = rules.find((r) => r.source === '/embed/:path*');
    const get = (rule: typeof all, key: string) => rule?.headers.find((h) => h.key === key)?.value;
    expect(get(all, 'Content-Security-Policy')).toBe("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'");
    expect(get(embed, 'Content-Security-Policy')).toBe("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self' https://partner.example https://ops.example.org");
    for (const rule of [all, embed]) {
      expect(get(rule, 'X-Content-Type-Options')).toBe('nosniff');
      expect(get(rule, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(get(rule, 'Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
      expect(get(rule, 'X-Frame-Options')).toBeUndefined();
    }
  });
});
