import { describe, it } from 'vitest';
import { replay, type Dataset } from '../src';
import { loadDataset } from '../src/data/loaders';
import { expectWithinBudget } from './bench.helpers';
import { DATA_DIR, et } from './helpers';

const dataset = loadDataset(DATA_DIR);
const DAY_MS = 86_400_000;

/** Ten copies of the day, each shifted by whole days, with event and consult ids remapped. */
function tenDays(d: Dataset): Dataset {
  const events = Array.from({ length: 10 }, (_, k) =>
    d.events.map((e) => ({
      ...e,
      rowIndex: k * d.events.length + e.rowIndex,
      eventId: `${e.eventId}~d${k}`,
      consultId: e.consultId === null ? null : `${e.consultId}~d${k}`,
      eventTime: e.eventTime + k * DAY_MS,
      ingestedAt: e.ingestedAt + k * DAY_MS,
    })),
  ).flat();
  return { ...d, events };
}

function medianMs(fn: () => unknown, runs: number): number {
  fn();
  const times = Array.from({ length: runs }, () => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  }).sort((a, b) => a - b);
  return times[Math.floor(runs / 2)] ?? Number.NaN;
}

describe('replay performance', () => {
  it('full stream < 50 ms; 10x synthetic stream < 400 ms', () => {
    const big = tenDays(dataset);
    const one = medianMs(() => replay(dataset, et('18:20:00')), 15);
    const ten = medianMs(() => replay(big, et('18:20:00') + 9 * DAY_MS), 5);
    console.log(`replay timings (median): 1x ${dataset.events.length} events = ${one.toFixed(1)} ms; 10x ${big.events.length} events = ${ten.toFixed(1)} ms`);
    expectWithinBudget('replay 1x (median)', one, 50);
    expectWithinBudget('replay 10x (median)', ten, 400);
  });
});
