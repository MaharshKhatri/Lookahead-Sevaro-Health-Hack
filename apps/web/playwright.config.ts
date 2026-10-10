import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against the production build (`next build` first; the
 * `e2e` script does it). One worker: every test starts with POST
 * /api/demo/reset on a throwaway data/live directory.
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);
const LIVE = process.env.E2E_LIVE_DIR ?? join(tmpdir(), `lookahead-e2e-live-${PORT}`);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', browserName: 'chromium' },
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/view`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { LOOKAHEAD_LIVE_DIR: LIVE, NEXT_TELEMETRY_DISABLED: '1' },
  },
});
