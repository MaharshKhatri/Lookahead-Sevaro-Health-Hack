import { describe, expect, it } from 'vitest';
import { applyCommand, type ActContext, type ActionLog, type Command } from '../src';
import { COORD, LEAD, dataset, phys } from './act.helpers';
import { et, seededShuffle } from './helpers';

const SKIP = process.env.LOOKAHEAD_SKIP_BENCH === '1';

function loop(c: ActContext): ActionLog {
  const steps: [Command, string][] = [[{ type: 'proposeOffer', commandId: 'p', actor: COORD, physicianId: 'PHY-009' }, '18:21:00']];
  let log: ActionLog = [];
  const apply = (cmd: Command, hms: string) => {
    const r = applyCommand(c, log, cmd, et(hms));
    if (!r.ok) throw new Error(`${cmd.type}: ${r.code} ${r.message}`);
    log = r.log;
  };
  apply(...steps[0]!);
  const offerId = log[0]?.type === 'offer_proposed' ? log[0].payload.offerId : '';
  apply({ type: 'approveOffer', commandId: 'a', actor: LEAD, offerId }, '18:22:00');
  apply({ type: 'respond', commandId: 'r', actor: phys('PHY-009'), offerId, physicianId: 'PHY-009', response: 'accept' }, '18:24:00');
  return log;
}

describe('Act layer determinism and performance (CLAUDE.md rule 3)', () => {
  it('the same commands give a byte-identical log, also over 10 seeded shuffles of the Sevaro event order', () => {
    const baseline = JSON.stringify(loop({ dataset }));
    expect(JSON.stringify(loop({ dataset }))).toBe(baseline);
    for (let seed = 1; seed <= 10; seed++) expect(JSON.stringify(loop({ dataset: { ...dataset, events: seededShuffle(dataset.events, seed) } })), `seed ${seed}`).toBe(baseline);
  });

  it('applyCommand (propose and accept, each including decide) < 60 ms median', () => {
    const c = { dataset };
    loop(c);
    const proposeTimes: number[] = [];
    const acceptTimes: number[] = [];
    for (let i = 0; i < 9; i++) {
      let t0 = performance.now();
      const p = applyCommand(c, [], { type: 'proposeOffer', commandId: `b${i}`, actor: COORD, physicianId: 'PHY-009' }, et('18:21:00'));
      proposeTimes.push(performance.now() - t0);
      if (!p.ok) throw new Error(p.message);
      const offerId = p.log[0]?.type === 'offer_proposed' ? p.log[0].payload.offerId : '';
      const a = applyCommand(c, p.log, { type: 'approveOffer', commandId: `ba${i}`, actor: LEAD, offerId }, et('18:22:00'));
      if (!a.ok) throw new Error(a.message);
      t0 = performance.now();
      applyCommand(c, a.log, { type: 'respond', commandId: `br${i}`, actor: phys('PHY-009'), offerId, physicianId: 'PHY-009', response: 'accept' }, et('18:24:00'));
      acceptTimes.push(performance.now() - t0);
    }
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? Number.NaN;
    console.log(`applyCommand timing (median of 9): propose ${median(proposeTimes).toFixed(1)} ms, accept ${median(acceptTimes).toFixed(1)} ms`);
    if (SKIP) {
      console.log('LOOKAHEAD_SKIP_BENCH=1: timing threshold not enforced');
      return;
    }
    expect(median(proposeTimes)).toBeLessThan(60);
    expect(median(acceptTimes)).toBeLessThan(60);
  });
});
