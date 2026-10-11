import { DATA_DIR, body, req } from './helpers';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { forecast, replay, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import * as clockRoute from '@/app/api/clock/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as eventsRoute from '@/app/api/events/route';
import * as viewRoute from '@/app/api/view/route';
import type { ViewDTO } from '@/lib/dto';
import { fitMemoSize } from '@/server/forecast';
import { disposeStore } from '@/server/store';

/**
 * Phase 7: the forecast served by /api/view equals the engine's forecast at
 * the same instant (D-85), the Hawkes fit is memoized per dataset version and
 * minute, and an injected consult shows up in the radar's observed counts.
 */

const dataset = loadDataset(DATA_DIR);
const NOW = snapshotAsOfMs(dataset) ?? 0;
const engineForecast = forecast(dataset, replay(dataset, NOW), NOW);

const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));
const clock = (b: Record<string, unknown>) => clockRoute.POST(req('/api/clock', { method: 'POST', body: JSON.stringify(b) }));

beforeEach(async () => {
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterAll(() => disposeStore());

describe('forecast in /api/view (D-85)', () => {
  it('equals the engine forecast at 18:20: params, checkpoints, horizons and risk ranks per hospital', async () => {
    const f = (await view()).forecast;
    expect(f.params).toEqual(engineForecast.params);
    for (const h of engineForecast.hospitals) {
      const row = f.hospitals.find((x) => x.hospitalId === h.hospitalId);
      expect(row?.riskRank).toBe(h.riskRank);
      expect(row?.checkpoints).toEqual(h.checkpoints);
      expect(row?.horizons).toEqual(h.horizons);
      expect(row?.driverSentence).toBe(h.driverSentence);
      expect(row?.past.length).toBe(f.pastWindowMin / f.pastBucketMin);
    }
  });

  it('memoizes the fit per (dataset version, minute): repeated views and same-minute recomputes reuse it; an injected row refits', async () => {
    await view();
    const n = fitMemoSize();
    expect(n).toBeGreaterThanOrEqual(1);
    await clock({ action: 'set', nowMs: NOW });
    await view();
    expect(fitMemoSize()).toBe(n);
    const v = await view();
    const [e1] = v.sample.nextEventIds;
    const row = `${e1},2026-03-17T18:20:00-04:00,,${v.sample.nextConsultId},consult_received,,${v.sample.surgingHospitalId},Stroke consult request received`;
    expect((await eventsRoute.POST(req('/api/events', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: row }))).status).toBe(200);
    const after = await view();
    expect(fitMemoSize()).toBe(n + 1);
    // The radar's observed count and the spike chip both see the new consult.
    const before = v.forecast.hospitals.find((h) => h.hospitalId === v.sample.surgingHospitalId);
    const now = after.forecast.hospitals.find((h) => h.hospitalId === v.sample.surgingHospitalId);
    expect(now?.observedLast60).toBe((before?.observedLast60 ?? 0) + 1);
    expect(now?.past.at(-1)?.count).toBe((before?.past.at(-1)?.count ?? 0) + 1);
    expect(after.demand.find((d) => d.hospitalId === v.sample.surgingHospitalId)?.count).toBe((before?.observedLast60 ?? 0) + 1);
  });

  it('moving the clock to another minute refits and re-ranks from knowledge-time state only', async () => {
    const a = (await view()).forecast;
    await clock({ action: 'advance', minutes: 5 });
    const b = (await view()).forecast;
    expect(b.asOfMs).toBe(a.asOfMs + 5 * 60_000);
    expect(b.hospitals.every((h) => h.checkpoints[0]?.tMs === b.asOfMs)).toBe(true);
    const expected = forecast(dataset, replay(dataset, b.asOfMs), b.asOfMs);
    expect(b.hospitals.map((h) => [h.hospitalId, h.riskRank])).toEqual(expected.hospitals.map((h) => [h.hospitalId, h.riskRank]));
  });
});
