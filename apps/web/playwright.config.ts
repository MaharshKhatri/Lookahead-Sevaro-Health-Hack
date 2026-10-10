import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests against the production build (`next build` first; the
 * `e2e` script does it). One worker: every test starts with POST
 * /api/demo/reset on a throwaway data/live directory.
 *
 * Remote mode (`PLAYWRIGHT_BASE_URL=http://<host> pnpm --filter web e2e:remote`):
 * no local server; the @demo tests run against the deployed URL (and reset
 * its demo state). E2E_LEAD_PIN must match the server's LEAD_PIN (default 2026).
 */
const REMOTE = process.env.PLAYWRIGHT_BASE_URL;
const PORT = Number(process.env.E2E_PORT ?? 3200);
const LIVE = process.env.E2E_LIVE_DIR ?? join(tmpdir(), `lookahead-e2e-live-${PORT}`);
const remote = REMOTE !== undefined && REMOTE !== '';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: remote ? 10_000 : 5_000 },
  reporter: [['list']],
  use: { baseURL: remote ? REMOTE.replace(/\/$/, '') : `http://localhost:${PORT}`, trace: 'retain-on-failure', browserName: 'chromium' },
  ...(remote
    ? {}
    : {
        webServer: {
          command: `pnpm exec next start -p ${PORT}`,
          url: `http://localhost:${PORT}/api/view`,
          reuseExistingServer: false,
          timeout: 120_000,
          // NARRATION=off: Explain is deterministic (template) even on a machine with AWS credentials.
          env: { LOOKAHEAD_LIVE_DIR: LIVE, NEXT_TELEMETRY_DISABLED: '1', NARRATION: 'off', LEAD_PIN: '2026' },
        },
      }),
});
