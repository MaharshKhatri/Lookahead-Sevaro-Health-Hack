import { DATA_DIR, LIVE_DIR } from './helpers';
import { describe, expect, it } from 'vitest';
import { decide, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import { bucketEdges, shiftMarkers } from '@/server/grid';
import { RULE_LABELS, ledgerRow } from '@/server/ledger';
import { Store } from '@/server/store';
import { nextId } from '@/server/view';

const ds = loadDataset(DATA_DIR);
const now = snapshotAsOfMs(ds) ?? 0;
const d = decide(ds, now);

describe('ledger chips (brief "show every off-shift physician considered and the rule each one passed or failed")', () => {
  it('every rule at 18:20 gets a numeric chip (no fallback to the bare label): guards against engine wording drift', () => {
    for (const e of d.ledger) {
      for (const r of ledgerRow(e).rules) {
        if (r.pass === null) continue;
        expect(r.chip, `${e.physicianId} ${r.rule}: ${r.detail}`).not.toBe(RULE_LABELS[r.rule]);
      }
    }
  });

  it('chips carry the rule numbers from the engine detail', () => {
    const chip = (id: string, rule: string) => ledgerRow(d.ledger.find((e) => e.physicianId === id) ?? d.ledger[0]!).rules.find((r) => r.rule === rule)?.chip;
    expect(chip('PHY-009', 'ELIG_REST_10H')).toBe('Rest 11.6 h ≥ 10');
    expect(chip('PHY-014', 'ELIG_HOURS_60')).toBe('59+2=61 > 60');
    expect(chip('PHY-009', 'ELIG_MIN_OFFER_2H')).toBe('255−15=240 ≥ 120 min');
    expect(chip('PHY-011', 'ELIG_NO_SCHEDULE_OVERLAP')).toBe('Next shift +40 min');
  });
});

describe('coverage grid geometry', () => {
  it('first bucket starts at now, the rest on quarter hours, the last ends at the horizon', () => {
    const edges = bucketEdges(now, d.decisionCoverage.horizonEndMs);
    expect(edges[0]).toBe(now);
    expect(edges[1]! - now).toBe(10 * 60_000); // 18:20 -> 18:30
    for (const e of edges.slice(1, -1)) expect(e % (15 * 60_000)).toBe(0);
    expect(edges.at(-1)).toBe(d.decisionCoverage.horizonEndMs);
  });

  it('shift markers come from the staffing model (roster ends, expected arrivals)', () => {
    const m = shiftMarkers(d.detection.staffing.shifts, now, d.detection.coverage.horizonEndMs);
    const first = m[0];
    expect(first?.ends.map((x) => x.physicianId).sort()).toEqual(
      d.detection.staffing.shifts.filter((s) => s.endMs === first?.atMs).map((s) => s.physicianId).sort(),
    );
    expect(first?.starts.every((s) => s.confirmation === 'expected')).toBe(true);
  });
});

describe('nextId', () => {
  it('keeps prefix and width', () => {
    expect(nextId(['X-0098', 'X-0099'], 'X-')).toBe('X-0100');
    expect(nextId([], 'X-')).toBe('X-1');
  });
});

describe('sim clock play loop', () => {
  it('advances speed x step per real step and materializes ticks; pause stops it', async () => {
    const store = new Store({ data: DATA_DIR, live: LIVE_DIR }, 20);
    await store.reset();
    const start = store.snapshot().clock.nowMs;
    await store.moveClock({ action: 'play', speed: 60 });
    await new Promise((r) => setTimeout(r, 130));
    await store.moveClock({ action: 'pause' });
    const moved = store.snapshot().clock.nowMs - start;
    expect(moved).toBeGreaterThan(0);
    expect(moved % (20 * 60)).toBe(0);
    const paused = store.snapshot().clock.nowMs;
    await new Promise((r) => setTimeout(r, 60));
    expect(store.snapshot().clock.nowMs).toBe(paused);
    store.dispose();
  });
});
