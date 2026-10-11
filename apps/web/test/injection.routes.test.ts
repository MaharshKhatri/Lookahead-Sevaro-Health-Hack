import { DATA_DIR, body, lastStreamRow, req } from './helpers';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decide, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import * as clockRoute from '@/app/api/clock/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as eventsRoute from '@/app/api/events/route';
import * as viewRoute from '@/app/api/view/route';
import type { ViewDTO } from '@/lib/dto';
import type { InjectResult } from '@/server/store';
import { disposeStore } from '@/server/store';

/**
 * Injection scenarios through the HTTP routes (brief "What Teams Must
 * Demonstrate" #8): POST /api/events, then GET /api/view must reflect the
 * change. Mirrors packages/engine/test/injection.scenarios.test.ts 1, 4, 12,
 * 13 and 14 at the API level. Expected values come from the engine on the same
 * package; test-only ids EVT-9xxxx / CON-9xxx.
 */

const DAY = '2026-03-17';
const iso = (hms: string) => `${DAY}T${hms}-04:00`;
const row = (id: string, eventHms: string, ingest: string, consultId: string, type: string, physicianId: string, hospitalId: string, description: string) =>
  `${id},${iso(eventHms)},${ingest === '' ? '' : iso(ingest)},${consultId},${type},${physicianId},${hospitalId},${description}`;
const STROKE = 'Stroke consult request received';

const engine = (() => {
  const ds = loadDataset(DATA_DIR);
  return { ds, at1820: decide(ds, snapshotAsOfMs(ds) ?? 0) };
})();

const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));
const post = async (text: string) => {
  const r = await eventsRoute.POST(req('/api/events', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text }));
  return { status: r.status, result: await body<InjectResult & { ok: boolean }>(r) };
};
const clock = (b: Record<string, unknown>) => clockRoute.POST(req('/api/clock', { method: 'POST', body: JSON.stringify(b) }));

beforeEach(async () => {
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterAll(() => disposeStore());

describe('POST /api/events then GET /api/view (brief #8)', () => {
  it('1. another stroke consult at the surging hospital: demand chip 5 -> 6, new ROUTING_DEADLOCK in the top 3, consult listed, pre-existing ids stable', async () => {
    const before = await view();
    const surge = before.sample.surgingHospitalId;
    expect(surge).toBe(engine.at1820.detection.demand.find((d) => d.spike)?.hospitalId);
    expect(before.demand.find((d) => d.hospitalId === surge)?.count).toBe(5);
    // The clock is the reference 18:20; move to 18:22 so rows dated 18:21 are in the past (D-20) and ingested_at defaults to the clock.
    await clock({ action: 'advance', minutes: 2 });
    const at1822 = await view();
    const { status, result } = await post([row('EVT-90001', '18:21:00', '', 'CON-9001', 'consult_received', '', surge ?? '', STROKE), row('EVT-90002', '18:21:30', '', 'CON-9001', 'consult_triaged', '', surge ?? '', 'Consult triaged')].join('\n'));
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.accepted.map((a) => [a.line, a.eventId, a.ingestedAtDefaulted])).toEqual([[1, 'EVT-90001', true], [2, 'EVT-90002', true]]);
    expect(result.knownFromMs).toBeNull();
    const after = await view();
    expect(after.demand.find((d) => d.hospitalId === surge)).toMatchObject({ count: 6, p90: 1 });
    expect(after.demand.find((d) => d.hospitalId === surge)?.contributingConsultIds).toContain('CON-9001');
    expect(after.consults.find((c) => c.consultId === 'CON-9001')).toMatchObject({ stage: 'Triaged', type: 'Stroke', hospitalId: surge, assigned: null });
    const item = after.attention.find((a) => a.kind === 'ROUTING_DEADLOCK' && a.consultIds.includes('CON-9001'));
    expect(item).toBeDefined();
    expect(item?.rank).toBeLessThanOrEqual(3);
    const ids = new Set(after.attention.map((a) => a.id));
    for (const a of at1822.attention) expect(ids.has(a.id), a.headline).toBe(true);
    expect(after.integrity.appendedCount).toBe(2);
    expect(after.version).toBeGreaterThan(at1822.version);
    // The coverage grid's first bucket for the surging hospital is a DEADLOCK cell.
    expect(after.coverage.rows.find((r) => r.hospitalId === surge)?.cells[0]?.class).toBe('DEADLOCK');
    expect(after.coverage.rows.find((r) => r.hospitalId === surge)?.routableNow).toBe(0);
  });

  it('4. OQ-04: re-sending the last stream row is reported as a duplicate with its line; nothing is appended and the view is unchanged', async () => {
    const before = await view();
    const { result } = await post(`${lastStreamRow()}\n${lastStreamRow()}`);
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(result.duplicates.map((d) => [d.line, d.eventId])).toEqual([[1, 'EVT-01163'], [2, 'EVT-01163']]);
    expect(result.duplicates[0]?.reason).toContain('OQ-04');
    const after = await view();
    expect(after.integrity.appendedCount).toBe(0);
    expect(after.version).toBe(before.version);
    expect(after.attention.map((a) => [a.id, a.score])).toEqual(before.attention.map((a) => [a.id, a.score]));
    expect(after.integrity.duplicates).toBe(before.integrity.duplicates);
  });

  it('12. D-26: unknown hospital/physician ids are accepted with warnings naming them; a row missing its required column is rejected with the line and column', async () => {
    await clock({ action: 'advance', minutes: 2 });
    const { result } = await post(
      [
        row('EVT-90101', '18:21:00', '18:21:02', 'CON-9101', 'consult_received', '', 'SYN-999', STROKE),
        row('EVT-90102', '18:21:10', '18:21:12', '', 'physician_status_changed', 'PHY-999', '', 'Self-reported status: Available'),
        row('EVT-90103', '18:21:20', '18:21:22', 'CON-2105', 'physician_assigned', '', 'SYN-010', 'Assigned'),
      ].join('\n'),
    );
    expect(result.ok).toBe(false);
    expect(result.accepted.map((a) => a.eventId)).toEqual(['EVT-90101', 'EVT-90102']);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('unknown hospital_id SYN-999'), expect.stringContaining('unknown physician_id PHY-999')]));
    expect(result.rejected).toEqual([{ line: 3, reason: expect.stringContaining('physician_id') }]);
    const v = await view();
    expect(v.consults.find((c) => c.consultId === 'CON-9101')).toMatchObject({ hospitalId: 'SYN-999', hospitalName: '-', stage: 'Received', type: 'Stroke' });
    expect(v.consults.find((c) => c.consultId === 'CON-2105')?.assigned).toBeNull();
    expect(v.physicians.some((p) => p.physicianId === 'PHY-999')).toBe(false); // the roster table lists rostered physicians only
    expect(v.integrity.appendedCount).toBe(2);
  });

  it('13. malformed timestamps and wrong cell counts are rejected per line, naming the column; the good row lands', async () => {
    await clock({ action: 'advance', minutes: 2 });
    const { status, result } = await post(
      [
        `EVT-90111,2026-03-17T18:21:00,${iso('18:21:02')},CON-9111,consult_received,,SYN-001,${STROKE}`,
        `EVT-90112,yesterday evening,${iso('18:21:02')},CON-9112,consult_received,,SYN-001,${STROKE}`,
        `EVT-90113,${iso('18:21:00')},${iso('18:21:02')},CON-9113,consult_received,,SYN-001`,
        row('EVT-90114', '18:21:00', '18:21:02', 'CON-9114', 'consult_received', '', 'SYN-001', 'General Neuro consult request received'),
      ].join('\n'),
    );
    expect(status).toBe(200);
    expect(result.ok).toBe(false);
    expect(result.rejected.map((x) => x.line)).toEqual([1, 2, 3]);
    expect(result.rejected[0]?.reason).toMatch(/column "event_time".*explicit UTC offset/);
    expect(result.rejected[1]?.reason).toMatch(/column "event_time"/);
    expect(result.rejected[2]?.reason).toBe('expected 8 cells, got 7');
    expect(result.accepted.map((a) => a.eventId)).toEqual(['EVT-90114']);
    const v = await view();
    expect(v.consults.map((c) => c.consultId)).toContain('CON-9114');
    expect(v.consults.map((c) => c.consultId)).not.toContain('CON-9111');
    expect(v.integrity.appendedCount).toBe(1);
  });

  it('14. D-20: a future-dated row returns knownFromMs and stays out of the view until the clock is set there', async () => {
    const before = await view();
    const futureMs = Date.parse(iso('18:50:00'));
    const { result } = await post(row('EVT-90121', '18:50:00', '18:50:02', 'CON-9121', 'consult_received', '', 'SYN-001', STROKE));
    expect(result.ok).toBe(true);
    expect(result.accepted.map((a) => a.eventId)).toEqual(['EVT-90121']);
    expect(result.knownFromMs).toBe(futureMs + 2_000);
    const still = await view();
    expect(still.clock.nowMs).toBe(before.clock.nowMs);
    expect(still.consults.some((c) => c.consultId === 'CON-9121')).toBe(false);
    expect(still.attention.map((a) => a.id)).toEqual(before.attention.map((a) => a.id));
    expect(still.integrity.appendedCount).toBe(1); // appended to the store, not yet known to the engine
    const moved = await clock({ action: 'set', nowMs: result.knownFromMs });
    expect(moved.status).toBe(200);
    const later = await view();
    expect(later.clock.nowMs).toBe(result.knownFromMs);
    expect(later.consults.find((c) => c.consultId === 'CON-9121')).toMatchObject({ stage: 'Received', hospitalId: 'SYN-001', type: 'Stroke', minSinceReceived: 0 });
    // One millisecond before ingestion it is still unknown (knowledge time).
    await clock({ action: 'set', nowMs: (result.knownFromMs ?? 0) - 1 });
    expect((await view()).consults.some((c) => c.consultId === 'CON-9121')).toBe(false);
  });
});
