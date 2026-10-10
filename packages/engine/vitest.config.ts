import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Provides the worker count to the timing tests (test/bench.helpers.ts, DECISIONS D-62).
    globalSetup: ['test/bench.setup.ts'],
  },
});
