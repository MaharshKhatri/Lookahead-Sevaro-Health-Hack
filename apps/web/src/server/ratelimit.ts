import 'server-only';
import { StoreError } from './store';

/**
 * In-memory token buckets per (bucket, client key) (D-91). One bucket per
 * limited surface: auth (POST /api/auth/*), physician commands, event
 * injection. Limits are per minute and env-configurable:
 *   RATE_LIMIT_AUTH_PER_MIN (10), RATE_LIMIT_PHYSICIAN_PER_MIN (30),
 *   RATE_LIMIT_EVENTS_PER_MIN (60). 0 disables a bucket.
 * Single-process state: a multi-instance deployment limits per instance,
 * which is still a brake on brute force (the PIN space is small, so the auth
 * bucket matters most). Tests call resetRateLimits().
 */

export type RateBucket = 'auth' | 'physician' | 'events';

const DEFAULTS: Readonly<Record<RateBucket, { readonly env: string; readonly perMin: number }>> = {
  auth: { env: 'RATE_LIMIT_AUTH_PER_MIN', perMin: 10 },
  physician: { env: 'RATE_LIMIT_PHYSICIAN_PER_MIN', perMin: 30 },
  events: { env: 'RATE_LIMIT_EVENTS_PER_MIN', perMin: 60 },
};

interface Bucket {
  tokens: number;
  updatedMs: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimitPerMinute(bucket: RateBucket): number {
  const raw = process.env[DEFAULTS[bucket].env];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULTS[bucket].perMin;
}

/** Takes one token; returns the tokens left, or -1 when the bucket is empty. */
export function takeToken(bucket: RateBucket, key: string, nowMs = Date.now()): number {
  const perMin = rateLimitPerMinute(bucket);
  if (perMin === 0) return Number.POSITIVE_INFINITY;
  const id = `${bucket}|${key}`;
  const b = buckets.get(id) ?? { tokens: perMin, updatedMs: nowMs };
  const refill = ((nowMs - b.updatedMs) / 60_000) * perMin;
  b.tokens = Math.min(perMin, b.tokens + Math.max(0, refill));
  b.updatedMs = nowMs;
  if (b.tokens < 1) {
    buckets.set(id, b);
    return -1;
  }
  b.tokens -= 1;
  buckets.set(id, b);
  if (buckets.size > 10_000) buckets.clear();
  return Math.floor(b.tokens);
}

/** Throws 429 RATE_LIMITED when the client has used its budget for this minute. */
export function enforceRateLimit(bucket: RateBucket, key: string, nowMs = Date.now()): void {
  if (takeToken(bucket, key, nowMs) < 0) throw new StoreError('RATE_LIMITED', `too many ${bucket} requests; limit ${rateLimitPerMinute(bucket)} per minute per client`);
}

/** Tests: forget every bucket. */
export function resetRateLimits(): void {
  buckets.clear();
}
