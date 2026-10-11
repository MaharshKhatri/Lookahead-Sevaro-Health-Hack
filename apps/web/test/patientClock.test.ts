import { DATA_DIR, body, req } from './helpers';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PATIENT_CLOCK_WARNING_MIN, patientClockAt } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import * as clockRoute from '@/app/api/clock/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as eventsRoute from '@/app/api/events/route';
import * as patientClockRoute from '@/app/api/patient-clock/route';
import type { PatientClockResponse } from '@/server/patientClock';
import { disposeStore } from '@/server/store';

/**
 * GET /api/patient-clock (sprint A2): the engine's topUnassignedStroke at the
 * sim clock, reshaped. Expected values come from the engine on the same
 * package; injected rows use test-only ids EVT-9xxxx / CON-9xxx.
 */

const ds = loadDataset(DATA_DIR);
const get = async () => body<PatientClockResponse>(await patientClockRoute.GET());
const post = async (text: string) => {
  const r = await eventsRoute.POST(req('/api/events', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text }));
  return { status: r.status, result: await body<{ ok: boolean; rejected: unknown[] }>(r) };
};
const clock = (b: Record<string, unknown>) => clockRoute.POST(req('/api/clock', { method: 'POST', body: JSON.stringify(b) }));
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

beforeEach(async () => {
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterAll(() => disposeStore());

describe('GET /api/patient-clock', () => {
  it('returns the engine answer at the sim clock with clock mode, speed and version', async () => {
    const r = await get();
    expect(typeof r.nowMs).toBe('number');
    expect(['paused', 'playing']).toContain(r.clockMode);
    expect(typeof r.clockSpeed).toBe('number');
    expect(typeof r.version).toBe('number');
    const engine = patientClockAt(ds, r.nowMs);
    expect(r.clock?.consultId ?? null).toBe(engine?.consultId ?? null);
    if (engine !== null) {
      expect(r.clock).toMatchObject({
        hospitalId: engine.hospitalId,
        hospitalName: engine.hospitalName,
        unassignedSinceMs: engine.unassignedSinceMs,
        routingFailureCount: engine.routingFailureCount,
        credentialedRoutableNow: engine.credentialedRoutableNow,
        credentialedTotal: engine.credentialedTotal,
        severity: engine.severity,
        neuronsAtRiskEstimate: engine.neuronsAtRiskEstimate,
        rankReason: engine.rankReason,
      });
    }
  });

  it('follows injection: a new stroke consult raises the candidate count; assigning the top consult moves the clock', async () => {
    const before = await get();
    expect(before.clock).not.toBeNull();
    const top = before.clock;
    if (top === null) return;
    // Advance so the injected rows are in the past (knowledge time, D-20); ingested_at defaults to the clock.
    expect((await clock({ action: 'advance', minutes: 2 })).status).toBe(200);
    const at = (await get()).nowMs;
    // Dated past the warning threshold so the new consult is a candidate with a severity regardless of routability.
    const received = at - (PATIENT_CLOCK_WARNING_MIN + 1) * 60_000;
    const inj = await post(`EVT-90101,${iso(received)},,CON-9101,consult_received,,${top.hospitalId},Stroke consult request received`);
    expect(inj.status).toBe(200);
    expect(inj.result.ok).toBe(true);
    const withNew = await get();
    expect(withNew.version).toBeGreaterThan(before.version);
    expect(withNew.clock?.candidateCount).toBe(top.candidateCount + 1);

    const physicianId = ds.physiciansOnShift[0]?.physicianId ?? '';
    const assign = await post(`EVT-90102,${iso(at - 10_000)},,${top.consultId},physician_assigned,${physicianId},${top.hospitalId},Consult assigned`);
    expect(assign.result.ok).toBe(true);
    const after = await get();
    expect(after.clock).not.toBeNull();
    expect(after.clock?.consultId).not.toBe(top.consultId);
    expect(after.clock?.candidateCount).toBe(top.candidateCount);
  });
});
