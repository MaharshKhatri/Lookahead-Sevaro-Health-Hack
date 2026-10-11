import type { NextConfig } from 'next';

/**
 * Security headers (D-91). `script-src 'unsafe-inline'` is required by Next's
 * hydration and RSC payload scripts (a nonce-based policy needs per-request
 * rendering of every page); styles are inline for Tailwind v4 and server
 * components. There is no X-Frame-Options: CSP frame-ancestors governs
 * framing, so /embed/* can be opened from LOOKAHEAD_EMBED_ORIGINS (a space-
 * or comma-separated list of origins) while every other page is 'self' only.
 * These headers are compiled into the build; src/middleware.ts re-applies the
 * /embed policy from the runtime environment.
 */
export function embedOrigins(env: string | undefined = process.env.LOOKAHEAD_EMBED_ORIGINS): string[] {
  return (env ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && /^https?:\/\/[^\s'";]+$/.test(s));
}

const CSP_BASE = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "font-src 'self' data:"];

export const csp = (frameAncestors: readonly string[] = []) => [...CSP_BASE, `frame-ancestors 'self' ${frameAncestors.join(' ')}`.trim()].join('; ');

export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

export function securityHeaders(env: string | undefined = process.env.LOOKAHEAD_EMBED_ORIGINS) {
  return [
    { source: '/:path*', headers: [...SECURITY_HEADERS, { key: 'Content-Security-Policy', value: csp() }] },
    // Later rules win for the same key (Next merges headers in order), so /embed/* is embeddable from the configured origins.
    { source: '/embed/:path*', headers: [...SECURITY_HEADERS, { key: 'Content-Security-Policy', value: csp(embedOrigins(env)) }] },
  ];
}

const config: NextConfig = {
  // The engine ships TypeScript source (packages/engine/src); Next transpiles it.
  transpilePackages: ['@lookahead/engine'],
  // Root `pnpm lint` covers this app (eslint.config.js at the repo root).
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  reactStrictMode: true,
  // The repo root (not apps/web) holds the lockfile and data/.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  headers: async () => securityHeaders(),
};

export default config;
