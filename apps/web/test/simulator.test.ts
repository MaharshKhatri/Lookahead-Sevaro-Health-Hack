import { body, req } from './helpers';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as sendRoute from '@/app/api/simulator/send/route';
import * as sinkRoute from '@/app/api/simulator/webhook-sink/route';
import * as statusRoute from '@/app/api/simulator/status/route';
import * as viewRoute from '@/app/api/view/route';
import type { ViewDTO } from '@/lib/dto';
import { resetRateLimits } from '@/server/ratelimit';
import { type SimSendResult, type SinkEntry, isoInZone, resetSimulatorState } from '@/server/simulator';
import { signBody } from '@/server/sign';
import { disposeStore } from '@/server/store';
import type { IngestReportDTO } from '@/server/v1';
import { SIMULATOR_SINK_PATH, simulatorEnabled, simulatorSinkUrl, webhookConfig } from '@/server/webhooks';

/**
 * Upstream Event Simulator (sprint B1, LOOKAHEAD-DEFINED): rows built from the
 * live snapshot go through the real signed POST /api/v1/events handler; the
 * dev webhook sink verifies x-lookahead-signature. No ids are hard-coded:
 * every expectation is derived from the view or the send response.
 */

const SECRET = 'sim-test-ingest-secret';
const ENV_KEYS = ['LOOKAHEAD_INGEST_SECRET', 'LOOKAHEAD_WEBHOOK_SECRET', 'DEMO_MODE', 'SIMULATOR_ENABLED'] as const;

const send = async (b: Record<string, unknown>) => {
  const r = await sendRoute.POST(req('/api/simulator/send', { method: 'POST', body: JSON.stringify(b) }));
  return { status: r.status, body: await body<SimSendResult & { code?: string }>(r) };
};
const report = (r: SimSendResult) => r.report as IngestReportDTO;
const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));
const dataRow = (payload: string) => payload.split('\n')[1]?.split(',') ?? [];

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.LOOKAHEAD_INGEST_SECRET = SECRET;
  resetRateLimits();
  resetSimulatorState();
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterAll(() => disposeStore());

describe('upstream event simulator', () => {
  it('a signed stroke-consult send is accepted, its signature verifies against the secret, and the consult reaches the view', async () => {
    const before = await view();
    const top = [...before.forecast.hospitals].sort((a, b) => a.riskRank - b.riskRank)[0]?.hospitalId;
    const r = await send({ kind: 'stroke_consult' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe(200);
    expect(r.body.signatureHeader).toBe(signBody(SECRET, r.body.payload));
    expect(report(r.body).signature).toBe('verified');
    expect(report(r.body).accepted).toBe(1);
    expect(report(r.body).duplicates).toBe(0);
    const cols = dataRow(r.body.payload);
    expect(cols[4]).toBe('consult_received');
    expect(cols[7]).toBe('Stroke consult request received');
    // Default hospital = the forecast's top-risk hospital; ids are fresh (never already in the stream).
    expect(cols[6]).toBe(top);
    expect(before.consults.some((c) => c.consultId === cols[3])).toBe(false);
    expect(report(r.body).acceptedEventIds).toEqual([cols[0]]);
    // Timestamps carry an explicit offset (CLAUDE.md rule 4) and ingested_at is the sim clock.
    expect(cols[2]).toBe(isoInZone(before.clock.nowMs, 'America/New_York'));
    expect(cols[1]).toMatch(/[+-]\d\d:\d\d$/);
    const after = await view();
    // The new consult surfaces in the attention queue (it was not there before).
    expect(JSON.stringify(before.attention).includes(cols[3] ?? '')).toBe(false);
    expect(JSON.stringify(after.attention).includes(cols[3] ?? '')).toBe(true);
    expect(after.consults.some((c) => c.consultId === cols[3])).toBe(true);
    expect(after.version).toBeGreaterThan(before.version);
    expect(r.body.version).toBe(after.version);
    // Status reports the send.
    const st = await body<{ enabled: boolean; lastSentAtMs: number | null }>(await statusRoute.GET());
    expect(st.enabled).toBe(true);
    expect(st.lastSentAtMs).toBe(r.body.sentAtMs);
  });

  it('duplicate resends the last row byte-for-byte: duplicates 1, accepted 0 (OQ-04)', async () => {
    const first = await send({ kind: 'stroke_consult' });
    expect(report(first.body).accepted).toBe(1);
    const dup = await send({ kind: 'duplicate' });
    expect(dup.body.payload).toBe(first.body.payload);
    expect(report(dup.body).duplicates).toBe(1);
    expect(report(dup.body).accepted).toBe(0);
    expect(report(dup.body).duplicateEventIds).toEqual(report(first.body).acceptedEventIds);
  });

  it('late event: event_time 7 min before ingested_at is flagged late (OQ-12)', async () => {
    const r = await send({ kind: 'late' });
    expect(report(r.body).accepted).toBe(1);
    expect(report(r.body).late).toBe(1);
    const cols = dataRow(r.body.payload);
    expect(Date.parse(cols[2] ?? '') - Date.parse(cols[1] ?? '')).toBe(7 * 60_000);
  });

  it('every kind builds a row the ingest accepts from the current snapshot; consecutive sends never reuse an id', async () => {
    const v = await view();
    const phy = v.physicians[0]?.physicianId;
    const ids = new Set<string>();
    for (const b of [
      { kind: 'stroke_consult' },
      { kind: 'routing_failed' },
      { kind: 'physician_status', physicianId: phy, status: 'Temporarily Unavailable' },
      { kind: 'physician_status', physicianId: phy, status: 'Available' },
      { kind: 'camera_active', physicianId: phy },
      { kind: 'heartbeat_lost', physicianId: phy },
      { kind: 'note_signed' },
    ]) {
      const r = await send(b);
      expect(r.status, `${b.kind}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(report(r.body).accepted, `${b.kind}: ${JSON.stringify(r.body.report)}`).toBe(1);
      const id = dataRow(r.body.payload)[0] ?? '';
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect((await send({ kind: 'physician_status', physicianId: phy, status: 'In Meeting' })).status).toBe(400);
    expect((await send({ kind: 'nope' })).status).toBe(400);
  });

  it('unsigned in DEMO_MODE without a secret: signatureHeader null, verdict unsigned_demo', async () => {
    delete process.env.LOOKAHEAD_INGEST_SECRET;
    const r = await send({ kind: 'heartbeat_lost' });
    expect(r.body.signatureHeader).toBeNull();
    expect(report(r.body).signature).toBe('unsigned_demo');
  });

  it('webhook sink: a good signature is verified; a bad one is stored verified:false and answered 401', async () => {
    process.env.LOOKAHEAD_WEBHOOK_SECRET = 'hook-secret';
    const raw = JSON.stringify({ event: 'store.changed', version: 7 });
    const post = (sig: string) => sinkRoute.POST(req(SIMULATOR_SINK_PATH, { method: 'POST', headers: { 'x-lookahead-signature': sig }, body: raw }));
    expect((await post(signBody('hook-secret', raw))).status).toBe(200);
    expect((await post(signBody('wrong-secret', raw))).status).toBe(401);
    const { entries } = await body<{ entries: SinkEntry[] }>(await sinkRoute.GET());
    expect(entries.map((e) => e.verified)).toEqual([false, true]);
    expect(entries[1]?.version).toBe(7);
  });

  it('disabled (SIMULATOR_ENABLED=0, or DEMO_MODE=false without SIMULATOR_ENABLED=1): routes answer 404, status says disabled', async () => {
    process.env.SIMULATOR_ENABLED = '0';
    expect((await send({ kind: 'stroke_consult' })).status).toBe(404);
    expect((await sinkRoute.GET()).status).toBe(404);
    expect((await body<{ enabled: boolean }>(await statusRoute.GET())).enabled).toBe(false);
    delete process.env.SIMULATOR_ENABLED;
    process.env.DEMO_MODE = 'false';
    expect(simulatorEnabled()).toBe(false);
    process.env.SIMULATOR_ENABLED = '1';
    expect(simulatorEnabled()).toBe(true);
    // Explicitly enabled outside DEMO_MODE: the server signs, so sending needs a coordinator/admin session (same gate as /api/events).
    const r = await send({ kind: 'stroke_consult' });
    expect(r.status).not.toBe(200);
    expect(r.body.code).toBe('ROLE_SESSION_REQUIRED');
  });

  it('dispatcher default: the dev sink only when asked explicitly and no URL is configured', () => {
    expect(webhookConfig({}).url).toBeNull();
    expect(webhookConfig({}, { simulatorSink: true }).url).toBe(`http://127.0.0.1:3000${SIMULATOR_SINK_PATH}`);
    expect(webhookConfig({ PORT: '3200' }, { simulatorSink: true }).url).toBe(`http://127.0.0.1:3200${SIMULATOR_SINK_PATH}`);
    expect(simulatorSinkUrl({ LOOKAHEAD_PUBLIC_ORIGIN: 'https://ops.example/' })).toBe(`https://ops.example${SIMULATOR_SINK_PATH}`);
    expect(webhookConfig({ LOOKAHEAD_WEBHOOK_URL: 'https://hooks.example/x' }, { simulatorSink: true }).url).toBe('https://hooks.example/x');
    expect(webhookConfig({ LOOKAHEAD_WEBHOOK_URL: 'ftp://x' }, { simulatorSink: true }).url).toBeNull();
  });
});
