import type { NextConfig } from 'next';

/** Standalone marketing site for Lookahead (statically rendered). Not part of the product's pnpm workspace. */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
