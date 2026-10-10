import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveDir } from './paths';
import { StoreError } from './store';

/**
 * Demo-grade access control (OQ-44, Session 7):
 *  - Offer links carry t = HMAC(secret, offerId): only the person holding the
 *    delivered link (QR) can open the phone view or answer the offer.
 *  - The clinical lead (approvals, escalations) and dataset activation need a
 *    shared PIN (LEAD_PIN, default "2026"), remembered in an HttpOnly cookie
 *    holding HMAC(secret, PIN), never the PIN itself.
 * The secret is OFFER_LINK_SECRET, else a random one generated once and kept
 * in data/live/.secret so links survive restarts.
 */

export const LEAD_COOKIE = 'lh_lead';
export const DEFAULT_LEAD_PIN = '2026';
const LEAD_COOKIE_MAX_AGE_S = 12 * 3600;

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

export function offerToken(offerId: string): string {
  return mac('offer', offerId, 22);
}

export function verifyOfferToken(offerId: string, token: string | null | undefined): boolean {
  return typeof token === 'string' && token !== '' && same(token, offerToken(offerId));
}

export const offerPath = (offerId: string) => `/offer/${encodeURIComponent(offerId)}?t=${offerToken(offerId)}`;

const leadPin = () => process.env.LEAD_PIN ?? DEFAULT_LEAD_PIN;
export const leadCookieValue = () => mac('lead', leadPin(), 32);

export function pinMatches(pin: unknown): boolean {
  return typeof pin === 'string' && same(pin.trim(), leadPin());
}

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

export function isLead(req: Request): boolean {
  return isLeadCookieValue(cookieOf(req, LEAD_COOKIE));
}

export function requireLead(req: Request): void {
  if (!isLead(req)) throw new StoreError('PIN_REQUIRED', 'the clinical lead PIN is required (open /lead or switch role to enter it)');
}

export function leadSetCookie(): string {
  return `${LEAD_COOKIE}=${encodeURIComponent(leadCookieValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LEAD_COOKIE_MAX_AGE_S}`;
}
