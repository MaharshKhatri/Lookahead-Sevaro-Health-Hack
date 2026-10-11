import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Role } from '@lookahead/engine';
import { liveDir } from './paths';
import { StoreError } from './store';

/**
 * Access control (OQ-44, D-78, D-91):
 *  - Offer links carry t = HMAC(secret, offerId): only the person holding the
 *    delivered link (QR) can open the phone view or answer the offer.
 *  - Role sessions: `POST /api/auth/session {role, pin}` sets the HttpOnly
 *    cookie `lh_role` = role.expiry.HMAC(secret, "role:" + role + ":" + expiry).
 *    PINs: COORDINATOR_PIN (default 1234), LEAD_PIN (default 2026),
 *    ADMIN_PIN (default 4321). The clinical lead's older cookie `lh_lead`
 *    (HMAC of the PIN, D-78) still works: the lead role is satisfied by either.
 *  - DEMO_MODE (default true, for judging): the console switches to
 *    coordinator with no PIN, and inject / clock / reset stay open. With
 *    DEMO_MODE=false every command needs a session cookie granting the role in
 *    x-lookahead-role (401 ROLE_SESSION_REQUIRED), and the demo controls need
 *    a coordinator or admin session. The lead PIN is required in both modes.
 * The secret is OFFER_LINK_SECRET, else a random one generated once and kept
 * in data/live/.secret so links and sessions survive restarts.
 */

export const LEAD_COOKIE = 'lh_lead';
export const ROLE_COOKIE = 'lh_role';
export const DEFAULT_LEAD_PIN = '2026';
export const DEFAULT_COORDINATOR_PIN = '1234';
export const DEFAULT_ADMIN_PIN = '4321';
const LEAD_COOKIE_MAX_AGE_S = 12 * 3600;
export const ROLE_SESSION_MAX_AGE_S = 12 * 3600;

/** Roles a browser session can hold. `physician` is never a session: the offer / standby link token is the physician's credential. */
export type SessionRole = 'coordinator' | 'clinical_lead' | 'admin';
export const SESSION_ROLES: readonly SessionRole[] = ['coordinator', 'clinical_lead', 'admin'];

let cachedSecret: string | null = null;

function secret(): string {
  const env = process.env.OFFER_LINK_SECRET;
  if (env !== undefined && env !== '') return env;
  if (cachedSecret !== null) return cachedSecret;
  const dir = liveDir();
  const file = join(dir, '.secret');
  if (existsSync(file)) cachedSecret = readFileSync(file, 'utf8').trim();
  else {
    cachedSecret = randomBytes(32).toString('hex');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}

const mac = (purpose: string, value: string, length: number) => createHmac('sha256', secret()).update(`${purpose}:${value}`).digest('base64url').slice(0, length);

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** DEMO_MODE defaults to true (one-click role switching for judging); only the literal "false" turns it off. Read per call so tests can flip it. */
export const demoMode = (): boolean => process.env.DEMO_MODE !== 'false';

// ------------------------------------------------------------------ offer links

export function offerToken(offerId: string): string {
  return mac('offer', offerId, 22);
}

export function verifyOfferToken(offerId: string, token: string | null | undefined): boolean {
  return typeof token === 'string' && token !== '' && same(token, offerToken(offerId));
}

export const offerPath = (offerId: string) => `/offer/${encodeURIComponent(offerId)}?t=${offerToken(offerId)}`;

// ------------------------------------------------------------------ PINs

const leadPin = () => process.env.LEAD_PIN ?? DEFAULT_LEAD_PIN;
const pinFor = (role: SessionRole): string =>
  role === 'clinical_lead' ? leadPin() : role === 'coordinator' ? (process.env.COORDINATOR_PIN ?? DEFAULT_COORDINATOR_PIN) : (process.env.ADMIN_PIN ?? DEFAULT_ADMIN_PIN);

export const leadCookieValue = () => mac('lead', leadPin(), 32);

export function pinMatches(pin: unknown): boolean {
  return rolePinMatches('clinical_lead', pin);
}

export function rolePinMatches(role: SessionRole, pin: unknown): boolean {
  return typeof pin === 'string' && same(pin.trim(), pinFor(role));
}

export const isSessionRole = (v: unknown): v is SessionRole => typeof v === 'string' && (SESSION_ROLES as readonly string[]).includes(v);

// ------------------------------------------------------------------ cookies

/** Parses the Cookie header (route handlers receive a plain Request). */
export function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function isLeadCookieValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && same(value, leadCookieValue());
}

/** `lh_role` value: role.expiryMs.mac, where mac = HMAC(secret, "role:" + role + ":" + expiryMs). */
export function roleSessionValue(role: SessionRole, expiresAtMs: number): string {
  return `${role}.${expiresAtMs}.${mac('role', `${role}:${expiresAtMs}`, 32)}`;
}

/** The role a `lh_role` cookie grants at nowMs, or null when missing, tampered or expired. */
export function parseRoleSession(value: string | null | undefined, nowMs: number): SessionRole | null {
  if (typeof value !== 'string') return null;
  const [role, exp, tag] = value.split('.');
  if (!isSessionRole(role) || exp === undefined || tag === undefined) return null;
  const expiresAtMs = Number(exp);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
  return same(tag, mac('role', `${role}:${expiresAtMs}`, 32)) ? role : null;
}

/** Every role this browser's cookies grant (admin implies coordinator and clinical lead for dataset administration; OQ-52). */
export function sessionRoles(req: Request, nowMs = Date.now()): ReadonlySet<SessionRole> {
  const roles = new Set<SessionRole>();
  if (isLeadCookieValue(cookieOf(req, LEAD_COOKIE))) roles.add('clinical_lead');
  const r = parseRoleSession(cookieOf(req, ROLE_COOKIE), nowMs);
  if (r !== null) roles.add(r);
  if (roles.has('admin')) {
    roles.add('coordinator');
    roles.add('clinical_lead');
  }
  return roles;
}

export function isLead(req: Request): boolean {
  return sessionRoles(req).has('clinical_lead');
}

/** Clinical-lead actions (approve, reject, authorize, dataset activate/revert) need the lead PIN in every mode (D-78). */
export function requireLead(req: Request): void {
  if (isLead(req)) return;
  if (demoMode()) throw new StoreError('PIN_REQUIRED', 'the clinical lead PIN is required (open /lead or switch role to enter it)');
  throw new StoreError('ROLE_SESSION_REQUIRED', 'a clinical-lead session is required (POST /api/auth/session with the lead PIN)');
}

/**
 * The actor role named in x-lookahead-role must be granted by this browser's
 * session (D-91). Coordinator is free in DEMO_MODE; the lead always needs the
 * PIN; a physician's credential is the offer / standby link token, checked by
 * the command route itself.
 */
export function requireRoleSession(req: Request, role: Role): void {
  if (role === 'physician' || role === 'system') return;
  if (role === 'clinical_lead') return requireLead(req);
  if (demoMode() || sessionRoles(req).has('coordinator')) return;
  throw new StoreError('ROLE_SESSION_REQUIRED', `a ${role} session is required (POST /api/auth/session {role, pin}); DEMO_MODE is off`);
}

/** Demo controls (inject, clock, reset): open in DEMO_MODE; otherwise a coordinator or admin session (D-91). */
export function requireDemoControl(req: Request | undefined): void {
  if (demoMode()) return;
  if (req !== undefined && sessionRoles(req).has('coordinator')) return;
  throw new StoreError('ROLE_SESSION_REQUIRED', 'a coordinator or admin session is required for demo controls; DEMO_MODE is off');
}

const cookieLine = (name: string, value: string, maxAgeS: number) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;

export function leadSetCookie(): string {
  return cookieLine(LEAD_COOKIE, leadCookieValue(), LEAD_COOKIE_MAX_AGE_S);
}

export function roleSetCookie(role: SessionRole, nowMs = Date.now()): string {
  return cookieLine(ROLE_COOKIE, roleSessionValue(role, nowMs + ROLE_SESSION_MAX_AGE_S * 1000), ROLE_SESSION_MAX_AGE_S);
}

export const clearCookie = (name: string) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** Client key for rate limiting: first x-forwarded-for hop, else x-real-ip, else "local" (route tests and the laptop). */
export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd !== null && fwd.trim() !== '') return fwd.split(',')[0]?.trim() ?? 'local';
  return req.headers.get('x-real-ip')?.trim() ?? 'local';
}

// ------------------------------------------------------------------ standby links (Phase 7)

/** Standby pre-alert / activation links carry t = HMAC(secret, "standby:" + standbyId), the offer scheme with its own purpose prefix. */
export function standbyToken(standbyId: string): string {
  return mac('standby', standbyId, 22);
}

export function verifyStandbyToken(standbyId: string, token: string | null | undefined): boolean {
  return typeof token === 'string' && token !== '' && same(token, standbyToken(standbyId));
}

export const standbyPath = (standbyId: string) => `/standby/${encodeURIComponent(standbyId)}?t=${standbyToken(standbyId)}`;
