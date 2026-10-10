import { availableParallelism } from 'node:os';
import type { TestProject } from 'vitest/node';

/**
 * Global setup: tells timing tests how many test files may run at once
 * (DECISIONS D-62). Thresholds are calibrated for an isolated run; under
 * parallel load the CPU is shared and medians drift.
 */
export default function setup(project: TestProject): void {
  const c = project.config;
  const single = c.poolOptions?.forks?.singleFork === true || c.poolOptions?.threads?.singleThread === true || c.fileParallelism === false;
  const workers = single ? 1 : (c.maxWorkers ?? Math.max(availableParallelism() - 1, 1));
  project.provide('benchWorkers', workers);
}

declare module 'vitest' {
  export interface ProvidedContext {
    benchWorkers: number;
  }
}
