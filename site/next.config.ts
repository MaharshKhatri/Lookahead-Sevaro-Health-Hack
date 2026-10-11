import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/** Standalone marketing site for Lookahead (statically rendered). Not part of the product's pnpm workspace. */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // site/ is its own app (own lockfile); trace files from here, not from the monorepo root.
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
};

export default config;
