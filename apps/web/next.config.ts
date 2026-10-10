import type { NextConfig } from 'next';

const config: NextConfig = {
  // The engine ships TypeScript source (packages/engine/src); Next transpiles it.
  transpilePackages: ['@lookahead/engine'],
  // Root `pnpm lint` covers this app (eslint.config.js at the repo root).
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  reactStrictMode: true,
  // The repo root (not apps/web) holds the lockfile and data/.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
};

export default config;
