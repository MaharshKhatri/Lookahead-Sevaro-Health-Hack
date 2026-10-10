import { describe, expect, it } from 'vitest';
import { detect } from '../src';
import { dataset } from './detect.helpers';
import { et } from './helpers';

const SKIP = process.env.LOOKAHEAD_SKIP_BENCH === '1';

describe('detect performance', () => {
  it('full detect at 18:20 (replay + routing + standards + demand + projection + attention) < 30 ms', () => {
    detect(dataset, et('18:20:00'));
    const times = Array.from({ length: 15 }, () => {
      const t0 = performance.now();
      detect(dataset, et('18:20:00'));
      return performance.now() - t0;
    }).sort((a, b) => a - b);
    const median = times[7] ?? Number.NaN;
    console.log(`detect timing (median of 15): ${median.toFixed(1)} ms`);
    if (SKIP) {
      console.log('LOOKAHEAD_SKIP_BENCH=1: timing threshold not enforced');
      return;
    }
    expect(median).toBeLessThan(30);
  });
});
