import { DATA_DIR, body, lastStreamRow, req } from './helpers';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as alertsRoute from '@/app/api/v1/alerts/route';
import * as coverageRoute from '@/app/api/v1/coverage/route';
import * as eventsRoute from '@/app/api/v1/events/route';
import * as forecastRoute from '@/app/api/v1/forecast/route';
import * as incidentsRoute from '@/app/api/v1/incidents/route';
import * as standbyRoute from '@/app/api/v1/standby/route';
import * as viewRoute from '@/app/api/view/route';
import type { ViewDTO } from '@/lib/dto';
import { resetRateLimits } from '@/server/ratelimit';
import { disposeStore } from '@/server/store';
import { type IngestReportDTO, SIGNATURE_HEADER, signBody } from '@/server/v1';

/**
 * Public v1 API (Phase 8, D-96): signed ingest at POST /api/v1/events and the
 * versioned read models. Expected values come from the engine on the same
 * package; test-only ids EVT-9xxxx / CON-9xxx (never in engine source).
 */

const SECRET = 'test-ingest-secret';
const DAY = '2026-03-17';
const iso = (hms: string) => `${DAY}T${hms}-04:00`;
const STROKE = 'Stroke consult request received';
const csvRow = (id: string, eventHms: string, ingestHms: string, consultId: string, type: string, physicianId: string, hospitalId: string, description: string) =>
  `${id},${iso(eventHms)},${ingestHms === '' ? '' : iso(ingestHms)},${consultId},${type},${physicianId},${hospitalId},${description}`;

const engine = (() => {
  const ds = loadDataset(DATA_DIR);
  const now = snapshotAsOfMs(ds) ?? 0;
  return { ds, now, at1820: decide(ds, now) };
})();
const surgingHospital = engine.at1820.detection.demand.find((d) => d.spike)?.hospitalId ?? engine.ds.hospitals[0]?.hospitalId ?? '';

const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));
const post = async (raw: string, opts: { sign?: string | null; contentType?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'text/csv' };
  const sig = opts.sign === undefined ? signBody(SECRET, raw) : opts.sign;
  if (sig !== null) headers[SIGNATURE_HEADER] = sig;
  const r = await eventsRoute.POST(req('/api/v1/events', { method: 'POST', headers, body: raw }));
  return { status: r.status, report: await body<IngestReportDTO & { code?: string }>(r) };
};

beforeEach(async () => {
  process.env.LOOKAHEAD_INGEST_SECRET = SECRET;
  delete process.env.DEMO_MODE;
  delete process.env.LOOKAHEAD_API_KEY;
  resetRateLimits();
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterEach(() => {
  delete process.env.LOOKAHEAD_INGEST_SECRET;
  delete process.env.DEMO_MODE;
  delete process.env.LOOKAHEAD_API_KEY;
});
afterAll(() => disposeStore());

describe('POST /api/v1/events (signed ingest)', () => {
  it('accepts a correctly signed CSV row, stamps schemaVersion 1.0, and the view reflects it', async () => {
    const before = (await view()).consults.length;
    const text = csvRow('EVT-91001', '18:19:30', '', 'CON-9101', 'consult_received', '', surgingHospital, STROKE);
    const { status, report } = await post(text);
    expect(status).toBe(200);
    expect(report.schemaVersion).toBe('1.0');
    expect(report.signature).toBe('verified');
    expect(report.format).toBe('csv');
    expect(report.accepted).toBe(1);
    expect(report.duplicates).toBe(0);
    expect(report.rejected).toEqual([]);
    expect(report.acceptedEventIds).toEqual(['EVT-91001']);
    expect((await view()).consults.length).toBe(before + 1);
  });

  it('refuses a tampered body (401 BAD_SIGNATURE) and a missing signature, appending nothing', async () => {
    const text = csvRow('EVT-91002', '18:19:30', '', 'CON-9102', 'consult_received', '', surgingHospital, STROKE);
    const tampered = await post(text, { sign: signBody(SECRET, `${text} `) });
    expect(tampered.status).toBe(401);
    expect(tampered.report.code).toBe('BAD_SIGNATURE');
    const unsigned = await post(text, { sign: null });
    expect(unsigned.status).toBe(401);
    expect(unsigned.report.code).toBe('BAD_SIGNATURE');
    const wrongSecret = await post(text, { sign: signBody('another-secret', text) });
    expect(wrongSecret.status).toBe(401);
    expect((await view()).consults.some((c) => c.consultId === 'CON-9102')).toBe(false);
  });

  it('is idempotent on event_id: a replayed row is a duplicate, never appended twice (OQ-04)', async () => {
    const text = csvRow('EVT-91003', '18:19:30', '', 'CON-9103', 'consult_received', '', surgingHospital, STROKE);
    expect((await post(text)).report.accepted).toBe(1);
    const again = await post(text);
    expect(again.status).toBe(200);
    expect(again.report.accepted).toBe(0);
    expect(again.report.duplicates).toBe(1);
    expect(again.report.duplicateEventIds).toEqual(['EVT-91003']);
    const known = await post(lastStreamRow());
    expect(known.report.duplicates).toBe(1);
    expect((await view()).consults.filter((c) => c.consultId === 'CON-9103').length).toBe(1);
  });

  it('takes JSON rows keyed by the CSV columns, reports rejected rows by array index, and counts late rows (OQ-12)', async () => {
    const rows = [
      { event_id: 'EVT-91004', event_time: iso('18:10:00'), ingested_at: iso('18:19:00'), consult_id: 'CON-9104', event_type: 'consult_received', physician_id: '', hospital_id: surgingHospital, description: STROKE },
      { event_id: 'EVT-91005', event_time: iso('18:19:40'), consult_id: 'CON-9105', event_type: 'consult_received', hospital_id: surgingHospital, description: STROKE },
      { event_id: 'EVT-91006', event_time: 'not a time', consult_id: 'CON-9106', event_type: 'consult_received', hospital_id: surgingHospital, description: STROKE },
    ];
    const raw = JSON.stringify(rows);
    const { status, report } = await post(raw, { contentType: 'application/json' });
    expect(status).toBe(207);
    expect(report.ok).toBe(false);
    expect(report.format).toBe('json');
    expect(report.rowBasis).toBe('index');
    expect(report.accepted).toBe(2);
    expect(report.late).toBe(1);
    expect(report.rejected.length).toBe(1);
    expect(report.rejected[0]?.row).toBe(2);
    const unknownField = await post(JSON.stringify([{ event_id: 'EVT-91007', eventTime: iso('18:19:00') }]), { contentType: 'application/json' });
    expect(unknownField.status).toBe(400);
    expect(unknownField.report.code).toBe('BAD_REQUEST');
  });

  it('without a secret: open in DEMO_MODE (signature "unsigned_demo"), 503 NOT_CONFIGURED with DEMO_MODE=false', async () => {
    delete process.env.LOOKAHEAD_INGEST_SECRET;
    const text = csvRow('EVT-91008', '18:19:30', '', 'CON-9108', 'consult_received', '', surgingHospital, STROKE);
    const demo = await post(text, { sign: null });
    expect(demo.status).toBe(200);
    expect(demo.report.signature).toBe('unsigned_demo');
    process.env.DEMO_MODE = 'false';
    const closed = await post(csvRow('EVT-91009', '18:19:30', '', 'CON-9109', 'consult_received', '', surgingHospital, STROKE), { sign: null });
    expect(closed.status).toBe(503);
    expect(closed.report.code).toBe('NOT_CONFIGURED');
  });
});

describe('GET /api/v1/* read models', () => {
  const get = (route: { GET: (r: Request) => Promise<Response> }, path: string, headers: Record<string, string> = {}) => route.GET(req(path, { headers }));

  it('every read model carries schemaVersion 1.0, asOfMs = sim clock and the dataset version', async () => {
    const v = await view();
    for (const [route, path] of [
      [forecastRoute, '/api/v1/forecast'],
      [standbyRoute, '/api/v1/standby'],
      [coverageRoute, '/api/v1/coverage'],
      [alertsRoute, '/api/v1/alerts'],
      [incidentsRoute, '/api/v1/incidents'],
    ] as const) {
      const r = await get(route, path);
      expect(r.status).toBe(200);
      const b = await body<{ schemaVersion: string; asOfMs: number; dataset: { key: string; version: number } }>(r);
      expect(b.schemaVersion).toBe('1.0');
      expect(b.asOfMs).toBe(v.clock.nowMs);
      expect(b.dataset.key).toBe(v.dataset.key);
      expect(b.dataset.version).toBe(v.version);
    }
  });

  it('alerts equal the engine attention list at 18:20 (ids, ranks, headlines); incidents equal the view intel', async () => {
    const a = await body<{ alerts: { id: string; rank: number; headline: string }[]; critical: number }>(await get(alertsRoute, '/api/v1/alerts'));
    expect(a.alerts.map((x) => [x.id, x.rank, x.headline])).toEqual(engine.at1820.detection.attention.map((x, i) => [x.id, i + 1, x.headline]));
    expect(a.critical).toBe(engine.at1820.detection.attention.filter((x) => x.severity === 'critical').length);
    const v = await view();
    const i = await body<{ incidents: unknown[]; reduction: unknown; nextBestActions: unknown[] }>(await get(incidentsRoute, '/api/v1/incidents'));
    expect(i.incidents).toEqual(v.intel.incidents);
    expect(i.reduction).toEqual(v.intel.reduction);
    expect(i.nextBestActions).toEqual(v.intel.nextBestActions);
  });

  it('forecast hospitals come sorted by riskRank; coverage lists every hospital with its cells; standby strips phone links', async () => {
    const f = await body<{ hospitals: { riskRank: number }[] }>(await get(forecastRoute, '/api/v1/forecast'));
    expect(f.hospitals.map((h) => h.riskRank)).toEqual([...f.hospitals].map((h) => h.riskRank).sort((x, y) => x - y));
    const c = await body<{ hospitals: { hospitalId: string; cells: { required: number; class: string }[] }[]; demand: unknown[] }>(await get(coverageRoute, '/api/v1/coverage'));
    expect(c.hospitals.length).toBe(engine.ds.hospitals.length);
    expect(c.hospitals.every((h) => h.cells.length > 0)).toBe(true);
    const s = await body<{ plan: { selected: unknown[] }; standbys: Record<string, unknown>[] }>(await get(standbyRoute, '/api/v1/standby'));
    expect(Array.isArray(s.plan.selected)).toBe(true);
    expect(JSON.stringify(s)).not.toContain('standbyPath');
    expect(JSON.stringify(s)).not.toContain('?t=');
  });

  it('with DEMO_MODE=false the read API needs LOOKAHEAD_API_KEY (401 API_KEY_REQUIRED; bearer or header accepted)', async () => {
    process.env.DEMO_MODE = 'false';
    const closed = await get(alertsRoute, '/api/v1/alerts');
    expect(closed.status).toBe(503);
    process.env.LOOKAHEAD_API_KEY = 'k-123';
    expect((await get(alertsRoute, '/api/v1/alerts')).status).toBe(401);
    expect((await get(alertsRoute, '/api/v1/alerts', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await get(alertsRoute, '/api/v1/alerts', { authorization: 'Bearer k-123' })).status).toBe(200);
    expect((await get(alertsRoute, '/api/v1/alerts', { 'x-lookahead-api-key': 'k-123' })).status).toBe(200);
  });
});
