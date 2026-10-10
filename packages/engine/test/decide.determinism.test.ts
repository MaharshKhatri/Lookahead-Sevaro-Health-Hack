import { describe, expect, it } from 'vitest';
import { decide, type DecisionReport } from '../src';
import { dataset } from './decide.helpers';
import { et, seededShuffle } from './helpers';

const SKIP = process.env.LOOKAHEAD_SKIP_BENCH === '1';
const view = (r: DecisionReport) => ({
  needs: r.needs,
  ledger: r.ledger,
  offer: r.recommendedOffer,
  arrivalTraps: r.arrivalTraps,
  interventions: r.interventions,
  recommendation: r.recommendation,
  whatIf: { before: r.whatIf.before, after: r.whatIf.after?.needs, changes: r.whatIf.changes, routable: r.whatIf.after?.routableAtOfferStart },
});

describe('decide() is pure and deterministic (CLAUDE.md rule 3)', () => {
  it('identical output for 20 seeded shuffles of the event order', () => {
    const baseline = JSON.stringify(view(decide(dataset, et('18:20:00'))));
    for (let seed = 1; seed <= 20; seed++) {
      const shuffled = { ...dataset, events: seededShuffle(dataset.events, seed) };
      expect(JSON.stringify(view(decide(shuffled, et('18:20:00')))), `seed ${seed}`).toBe(baseline);
    }
  });

  it('decide at 18:20 (detect + needs + ledger + trap + what-if + interventions) < 40 ms', () => {
    decide(dataset, et('18:20:00'));
    const times = Array.from({ length: 15 }, () => {
      const t0 = performance.now();
      decide(dataset, et('18:20:00'));
      return performance.now() - t0;
    }).sort((a, b) => a - b);
    const median = times[7] ?? Number.NaN;
    console.log(`decide timing (median of 15): ${median.toFixed(1)} ms`);
    if (SKIP) {
      console.log('LOOKAHEAD_SKIP_BENCH=1: timing threshold not enforced');
      return;
    }
    expect(median).toBeLessThan(40);
  });

  it('runs at other instants without throwing (no offer is a valid outcome)', () => {
    for (const hms of ['08:00:00', '12:00:00', '17:00:00', '18:00:00', '19:30:00']) {
      const r = decide(dataset, et(hms));
      expect(r.nowMs).toBe(et(hms));
      if (r.recommendedOffer !== null) expect(r.ledger.find((e) => e.physicianId === r.recommendedOffer?.physicianId)?.eligible).toBe(true);
    }
  });
});
