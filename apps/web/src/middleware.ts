import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware (D-91). Two jobs, both header-only; no auth decisions live
 * here (those are in the route handlers, which can verify HMACs with node:crypto):
 *  1. `/embed/*` (the projector/partner embed built later, e.g. /embed/surge)
 *     gets a Content-Security-Policy whose frame-ancestors lists
 *     LOOKAHEAD_EMBED_ORIGINS at RUN time. next.config headers() is baked into
 *     the build, so a Docker image or EC2 instance configured after `next build`
 *     still gets the right origins from here.
 *  2. Every other response gets `frame-ancestors 'self'` via next.config; the
 *     middleware only adds a request id for log correlation.
 */

const EMBED_PREFIX = '/embed';

function embedOrigins(env: string | undefined): string[] {
  return (env ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && /^https?:\/\/[^\s'";]+$/.test(s));
}

function embedCsp(env: string | undefined): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self' data:",
    `frame-ancestors 'self' ${embedOrigins(env).join(' ')}`.trim(),
  ].join('; ');
}

export function middleware(req: NextRequest): NextResponse {
  const res = NextResponse.next();
  if (req.nextUrl.pathname.startsWith(EMBED_PREFIX)) res.headers.set('content-security-policy', embedCsp(process.env.LOOKAHEAD_EMBED_ORIGINS));
  res.headers.set('x-request-id', crypto.randomUUID());
  return res;
}

export const config = {
  // Pages and API only; static assets and Next internals are left alone.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
