import { DATA_DIR, body, req } from './helpers';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decide, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import * as activateRoute from '@/app/api/dataset/activate/route';
import * as datasetRoute from '@/app/api/dataset/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as revertRoute from '@/app/api/dataset/revert/route';
import * as viewRoute from '@/app/api/view/route';
import type { ViewDTO } from '@/lib/dto';
import { LEAD_COOKIE, leadCookieValue } from '@/server/auth';
import type { StageResult } from '@/server/dataset';
import { disposeStore } from '@/server/store';
import { ORIGINAL_ID, writeMutatedPackage } from '../../../packages/engine/test/mutate.helpers';

/**
 * Generalization through the judging-day upload path (brief "What Teams Must
 * Demonstrate" #1, #5; OQ-45): a package with remapped ids, invented names, a
 * +1 day shift and permuted rows is uploaded, ingests 8/8 and 18/18, activates
 * with the lead PIN, and the Command Center shows the same answers under the
 * id map as the engine gives for data/raw.
 */

const original = (() => {
  const ds = loadDataset(DATA_DIR);
  return decide(ds, snapshotAsOfMs(ds) ?? 0);
})();
const dir = mkdtempSync(join(tmpdir(), 'lookahead-mutated-'));
const pkg = writeMutatedPackage(dir, 7, 1);
const mapId = pkg.mapId;
const cookie = () => `${LEAD_COOKIE}=${encodeURIComponent(leadCookieValue())}`;
const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));

async function upload(files: Record<string, string>): Promise<{ status: number; stage: StageResult }> {
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) form.append('files', new File([content], name));
  const r = await datasetRoute.POST(new Request('http://localhost:3000/api/dataset', { method: 'POST', body: form }));
  return { status: r.status, stage: await body<StageResult>(r) };
}

beforeAll(async () => {
  disposeStore();
  await resetRoute.POST();
});
afterAll(async () => {
  await revertRoute.POST(req('/api/dataset/revert', { method: 'POST', cookie: cookie() })).catch(() => undefined);
  disposeStore();
});

describe('mutated package through POST /api/dataset -> activate -> GET /api/view', () => {
  it('the written files carry no original id and ingest 8/8 and 18/18 against their own snapshot', async () => {
    const files = Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
    expect(Object.keys(files).sort()).toEqual(readdirSync(DATA_DIR).filter((n) => n.endsWith('.csv')).sort());
    for (const [name, text] of Object.entries(files)) expect(ORIGINAL_ID.test(text), name).toBe(false);
    const { status, stage } = await upload(files);
    expect(status).toBe(200);
    expect(stage.report.ok).toBe(true);
    expect(stage.canActivate).toBe(true);
    expect(stage.report.files.every((f) => f.kind !== null)).toBe(true);
    expect(stage.snapshot).toMatchObject({ label: '1820', physicians: '8/8', consults: '18/18', diffCount: 0 });
    expect(stage.eventCount).toBe(original.detection.staffing.refs.size + original.detection.state.integrity.duplicates.length);

    const denied = await activateRoute.POST(req('/api/dataset/activate', { method: 'POST', body: JSON.stringify({ stageId: stage.stageId }) }));
    expect(denied.status).toBe(401);
    const ok = await activateRoute.POST(req('/api/dataset/activate', { method: 'POST', body: JSON.stringify({ stageId: stage.stageId, label: 'mutated' }), cookie: cookie() }));
    expect(ok.status).toBe(200);
  });

  it('the view at the shifted 18:20 recommends the mapped physician with the mapped scope, and the ledger verdicts match under the id map', async () => {
    const v = await view();
    expect(v.dataset.source).toBe('upload');
    expect(v.clock.nowMs).toBe(original.nowMs + 24 * 3_600_000);
    expect(v.clock.scenarioDate).toBe('2026-03-18');
    expect(v.integrity).toMatchObject({ physicians: '8/8 rows match', consults: '18/18 rows match', diffs: 0 });
    expect(v.recommendedOffer?.physicianId).toBe(mapId(original.recommendedOffer?.physicianId ?? ''));
    expect(v.recommendedOffer?.routingScope).toEqual(original.recommendedOffer?.routingScope.map(mapId));
    expect(v.recommendedOffer?.seededConsultCount).toBe(original.recommendedOffer?.seededConsultCount);
    expect(v.recommendedOffer?.value).toBe(original.recommendedOffer?.value);
    // Ledger rows follow the (permuted) roster order; compare per mapped physician.
    expect([...v.ledger.map((r) => r.physicianId)].sort()).toEqual(original.ledger.map((e) => mapId(e.physicianId)).sort());
    for (const e of original.ledger) {
      const r = v.ledger.find((x) => x.physicianId === mapId(e.physicianId));
      expect(r, e.physicianId).toBeDefined();
      expect([r?.eligible, r?.rank, r?.value, r?.failedRules], e.physicianId).toEqual([e.eligible, e.rank, e.value, e.rules.filter((x) => x.pass === false).map((x) => x.rule)]);
      expect(r?.scopeHospitalIds, e.physicianId).toEqual(e.scopeHospitalIds.map(mapId));
    }
    // Same deadlocks, spike and attention ranking (kinds and scores) as the engine on data/raw, mapped.
    expect(v.demand.map((d) => [d.hospitalId, d.count])).toEqual(original.detection.demand.filter((d) => d.spike).map((d) => [mapId(d.hospitalId), d.count]));
    expect(v.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => n.hospitalId).sort()).toEqual(
      original.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => mapId(n.hospitalId)).sort(),
    );
    expect(v.attention.map((a) => [a.kind, a.score])).toEqual(original.detection.attention.map((a) => [a.kind, a.score]));
    expect(v.attention[0]?.consultIds).toEqual(original.detection.attention[0]?.consultIds.map(mapId));
    // No original id leaks into the view.
    expect(ORIGINAL_ID.exec(JSON.stringify(v))?.[0]).toBeUndefined();
    expect(JSON.stringify(v)).toContain(mapId('SYN-005'));
  });

  it('revert restores data/raw', async () => {
    const r = await revertRoute.POST(req('/api/dataset/revert', { method: 'POST', cookie: cookie() }));
    expect(r.status).toBe(200);
    const v = await view();
    expect(v.dataset.source).toBe('raw');
    expect(v.recommendedOffer?.physicianId).toBe(original.recommendedOffer?.physicianId);
  });
});
