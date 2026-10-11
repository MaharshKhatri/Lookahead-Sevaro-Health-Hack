import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 body signatures shared by the v1 ingest endpoint and outbound webhooks (D-96). No imports from the store: this module sits below the cycle. */
export const V1_SCHEMA_VERSION = '1.0' as const;

/** `sha256=<hex>` of HMAC-SHA256(secret, raw body). */
export function signBody(secret: string, raw: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
