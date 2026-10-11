import { describe, expect, it } from 'vitest';
import { decide, diffSnapshot, parseDataset, replay, snapshotAsOfMs, toSnapshotConsultRows, toSnapshotPhysicianRows, type DecisionReport, type Need } from '../src';
import { decision1820 } from './decide.helpers';
import { et } from './helpers';
import { ORIGINAL_ID, mutatedPackage } from './mutate.helpers';

/**
 * CLAUDE.md rule 5 ("No hard-coding of answers"), brief "What Teams Must
 * Demonstrate" #1 (rebuild state from the stream) and #5 (eligibility ledger):
 * the same answers must come out of an isomorphic package whose ids, names,
 * dates and row order all differ from data/raw.
 */

const pkg = mutatedPackage(7, 1);
const mutated = parseDataset(pkg.texts);
const mapId = pkg.mapId;
/** 18:20 ET on the shifted scenario date (2026-03-18, still a weekday so the weekday baselines apply). */
const SHIFTED_1820 = Date.parse('2026-03-18T18:20:00-04:00');
const DAY_MS = 24 * 3_600_000;

const offsets = (n: Need, nowMs: number) => [n.kind, n.hospitalId, n.startMs - nowMs, n.endMs === 'beyond_horizon' ? 'beyond_horizon' : n.endMs - nowMs] as const;
const mappedOffsets = (n: Need, nowMs: number) => [n.kind, mapId(n.hospitalId), n.startMs - nowMs, n.endMs === 'beyond_horizon' ? 'beyond_horizon' : n.endMs - nowMs] as const;

/** JSON with Maps and Sets expanded, so nothing hides from the id search. */
const deepJson = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x));

describe('mutated package (ids, names, +1 day, permuted rows) parses and replays to its own snapshot', () => {
  it('no original id survives in the mutated texts; the mapped ids are present', () => {
    for (const [name, text] of Object.entries(pkg.texts)) expect(ORIGINAL_ID.test(text), name).toBe(false);
    expect(pkg.texts['credentialing_matrix.csv']?.split(/\r?\n/)[0]).toContain('HOSP-205');
    expect(pkg.texts['event_stream.csv']).toContain('2026-03-18T');
    expect(pkg.texts['event_stream.csv']).not.toContain('2026-03-17T');
    expect(Object.keys(pkg.texts)).toContain('snapshot_physicians_1820.csv');
  });

  it('parses with the same row counts and an ET scenario date one day later', () => {
    const original = decision1820().detection.state;
    expect(mutated.events).toHaveLength(decision1820().detection.staffing.refs.size + original.integrity.duplicates.length);
    expect(mutated.hospitals.map((h) => h.hospitalId).sort()).toEqual([...new Set(mutated.credentialHospitalIds)].sort());
    expect(snapshotAsOfMs(mutated)).toBe(SHIFTED_1820);
    expect(snapshotAsOfMs(mutated)).toBe(et('18:20:00') + DAY_MS);
    expect(replay(mutated, SHIFTED_1820).scenarioDate).toBe('2026-03-18');
  });

  it('brief #1: the replay matches the mutated snapshot 8/8 and 18/18 with zero diffs', () => {
    const state = replay(mutated, SHIFTED_1820);
    if (mutated.snapshot === null) throw new Error('mutated snapshot missing');
    const diff = diffSnapshot({ physicians: toSnapshotPhysicianRows(state), consults: toSnapshotConsultRows(state) }, mutated.snapshot);
    expect(diff.summary).toEqual({ physicians: '8/8 rows match', consults: '18/18 rows match' });
    expect(diff.diffs).toEqual([]);
  });
});

describe('isomorphism under the id map at the shifted 18:20 (detect + decide)', () => {
  let original: DecisionReport;
  let variant: DecisionReport;
  const ready = () => {
    original ??= decision1820();
    variant ??= decide(mutated, SHIFTED_1820);
    return { original, variant };
  };

  it('same deadlocked consults (mapped) and the same spiking hospital(s) (mapped)', () => {
    const { original, variant } = ready();
    expect(variant.detection.deadlocks.map((d) => d.consultId)).toEqual(original.detection.deadlocks.map((d) => mapId(d.consultId)));
    expect(variant.detection.demand.filter((d) => d.spike).map((d) => [d.hospitalId, d.count, d.p90])).toEqual(
      original.detection.demand.filter((d) => d.spike).map((d) => [mapId(d.hospitalId), d.count, d.p90]),
    );
    expect(variant.detection.deadlocks.length).toBeGreaterThan(0);
  });

  it('same needs: kind, mapped hospital, start/end offsets from now', () => {
    const { original, variant } = ready();
    expect(variant.needs.map((n) => offsets(n, variant.nowMs))).toEqual(original.needs.map((n) => mappedOffsets(n, original.nowMs)));
    expect(variant.needs.length).toBeGreaterThan(0);
  });

  it('brief #5: same eligibility verdicts per mapped physician (eligible, rank, value, failed rules, scope)', () => {
    const { original, variant } = ready();
    const row = (e: DecisionReport['ledger'][number]) => ({ eligible: e.eligible, rank: e.rank, value: e.value, failed: e.rules.filter((r) => r.pass === false).map((r) => r.rule) });
    // Ledger rows follow physicians_off_shift_roster.csv row order, which the mutation permutes: compare as a set.
    expect([...variant.ledger.map((e) => e.physicianId)].sort()).toEqual(original.ledger.map((e) => mapId(e.physicianId)).sort());
    for (const e of original.ledger) {
      const v = variant.ledger.find((x) => x.physicianId === mapId(e.physicianId));
      expect(v, e.physicianId).toBeDefined();
      if (v === undefined) continue;
      expect(row(v), e.physicianId).toEqual(row(e));
      expect(v.scopeHospitalIds, e.physicianId).toEqual(e.scopeHospitalIds.map(mapId));
      expect(v.coversNeeds.length, e.physicianId).toBe(e.coversNeeds.length);
    }
  });

  it('same recommended offer: mapped physician, mapped scope, same seed, same window offsets', () => {
    const { original, variant } = ready();
    const o = original.recommendedOffer;
    const v = variant.recommendedOffer;
    expect(o).not.toBeNull();
    expect(v).not.toBeNull();
    if (o === null || v === null) return;
    expect(v.physicianId).toBe(mapId(o.physicianId));
    expect(v.routingScope).toEqual(o.routingScope.map(mapId));
    expect(v.seededConsultCount).toBe(o.seededConsultCount);
    expect(v.trap.recommended).toBe(o.trap.recommended);
    expect([v.window.startMs - variant.nowMs, v.window.endMs - variant.nowMs, v.window.bindingCap]).toEqual([o.window.startMs - original.nowMs, o.window.endMs - original.nowMs, o.window.bindingCap]);
    expect(v.value).toBe(o.value);
  });

  it('brief #3: same attention kinds in the same order, same scores', () => {
    const { original, variant } = ready();
    // Ties are broken by the (hash) item id, which legitimately changes with the ids; compare the ranked (score, kind) sequence.
    const ranked = (d: DecisionReport) => d.detection.attention.map((a) => [a.score, a.kind] as const);
    expect(ranked(variant)).toEqual(ranked(original));
    expect(variant.detection.attention.map((a) => a.kind)).toEqual(original.detection.attention.map((a) => a.kind));
    // Every item's entities map one-to-one (rows with equal scores sorted, since their relative order is the id tie-break).
    const entities = (d: DecisionReport, f: (id: string) => string) =>
      d.detection.attention
        .map((a) => [a.kind, a.score, [...a.consultIds].map(f).sort(), [...a.hospitalIds].map(f).sort(), [...a.physicianIds].map(f).sort()] as const)
        .sort((a, b) => b[1] - a[1] || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(entities(variant, (x) => x)).toEqual(entities(original, mapId));
  });

  it('same interventions and recommendation shape (kinds, mapped targets)', () => {
    const { original, variant } = ready();
    const shape = (d: DecisionReport, f: (id: string) => string) =>
      d.interventions.map((i) => [i.kind, i.proposer, i.approver, i.acceptor, [...i.targets.consultIds].map(f), [...i.targets.hospitalIds].map(f), [...i.targets.physicianIds].map(f)]);
    expect(shape(variant, (x) => x)).toEqual(shape(original, mapId));
    expect(variant.recommendation?.actions.map((a) => a.kind)).toEqual(original.recommendation?.actions.map((a) => a.kind));
  });

  it('reverse check: no original id appears anywhere in the mutated outputs', () => {
    const { variant } = ready();
    const text = deepJson(variant);
    expect(text.length).toBeGreaterThan(10_000);
    expect(ORIGINAL_ID.exec(text)?.[0]).toBeUndefined();
    const warningsText = mutated.warnings.join('\n');
    expect(ORIGINAL_ID.test(warningsText)).toBe(false);
  });
});
