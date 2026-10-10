import { describe, it } from 'vitest';
import { detect } from '../src';
import { dataset } from './detect.helpers';
import { expectWithinBudget } from './bench.helpers';
import { et } from './helpers';

describe('detect performance', () => {
  it('full detect at 18:20 (replay + routing + standards + demand + projection + attention) < 30 ms', () => {
    detect(dataset, et('18:20:00'));
    const times = Array.from({ length: 15 }, () => {
      const t0 = performance.now();
      detect(dataset, et('18:20:00'));
      return performance.now() - t0;
    }).sort((a, b) => a - b);
    const median = times[7] ?? Number.NaN;
    expectWithinBudget('detect timing (median of 15)', median, 30);
  });
});
