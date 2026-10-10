import { DATA_DIR, body, req } from './helpers';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as activateRoute from '@/app/api/dataset/activate/route';
import * as mappingRoute from '@/app/api/dataset/mapping/route';
import * as revertRoute from '@/app/api/dataset/revert/route';
import * as datasetRoute from '@/app/api/dataset/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as viewRoute from '@/app/api/view/route';
import type { ViewDTO } from '@/lib/dto';
import { LEAD_COOKIE, leadCookieValue } from '@/server/auth';
import type { StageResult } from '@/server/dataset';
import { disposeStore } from '@/server/store';

/**
 * Dataset swap for judging (Session 7): POST /api/dataset runs the engine's
 * schema-adaptive ingestion (OQ-45) on an upload and reports; activate swaps
 * the store's dataset; revert restores the previous one.
 */

const raw: Record<string, string> = Object.fromEntries(readdirSync(DATA_DIR).filter((n) => n.endsWith('.csv')).map((n) => [n, readFileSync(join(DATA_DIR, n), 'utf8')]));
const replaceHeader = (text: string, header: string) => header + text.slice(text.search(/\r?\n/));
const cookie = () => `${LEAD_COOKIE}=${encodeURIComponent(leadCookieValue())}`;

async function upload(files: Record<string, string | Uint8Array>, mapping?: unknown): Promise<{ status: number; stage: StageResult }> {
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) form.append('files', new File([typeof content === 'string' ? content : new Uint8Array(content)], name));
  if (mapping !== undefined) form.append('mapping', JSON.stringify(mapping));
  const r = await datasetRoute.POST(new Request('http://localhost:3000/api/dataset', { method: 'POST', body: form }));
  return { status: r.status, stage: await body<StageResult>(r) };
}
const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));
const activate = (stageId: string, withPin = true) => activateRoute.POST(req('/api/dataset/activate', { method: 'POST', body: JSON.stringify({ stageId }), ...(withPin ? { cookie: cookie() } : {}) }));

beforeAll(async () => {
  disposeStore();
  await resetRoute.POST();
});
afterAll(() => disposeStore());

describe('POST /api/dataset: upload + ingest report', () => {
  it('the original data/raw files: every file recognised, 8/8 and 18/18, activatable', async () => {
    const { status, stage } = await upload(raw);
    expect(status).toBe(200);
    expect(stage.report.ok).toBe(true);
    expect(stage.canActivate).toBe(true);
    expect(stage.report.files.every((f) => f.kind !== null)).toBe(true);
    expect(stage.snapshot).toMatchObject({ label: '1820', physicians: '8/8', consults: '18/18', diffCount: 0 });
  });

  it('renamed headers ("Event time", "Phys.", the brief\'s own table headers) ingest, each mapping reported with its method', async () => {
    const files = { ...raw, 'event_stream.csv': replaceHeader(raw['event_stream.csv'] ?? '', 'Event,Event time,Ingested,Consult,Type,Phys.,Hosp.,Description') };
    const { stage } = await upload(files);
    expect(stage.report.ok).toBe(true);
    const ev = stage.report.files.find((f) => f.kind === 'events');
    expect(ev?.mapped.find((m) => m.source === 'Event time')).toEqual({ source: 'Event time', column: 'event_time', method: 'normalized' });
    expect(ev?.mapped.find((m) => m.source === 'Phys.')).toEqual({ source: 'Phys.', column: 'physician_id', method: 'alias' });
    expect(stage.snapshot?.diffCount).toBe(0);
  });

  it('a missing required column is a clear error with a suggestion; a mapping override re-ingests it', async () => {
    const files = { ...raw, 'event_stream.csv': replaceHeader(raw['event_stream.csv'] ?? '', 'event_id,event_time,ingested_at,consult_id,what_happened,physician_id,hospital_id,description') };
    const { stage } = await upload(files);
    expect(stage.report.ok).toBe(false);
    expect(stage.canActivate).toBe(false);
    const ev = stage.report.files.find((f) => f.kind === 'events');
    expect(ev?.missing.map((m) => [m.column, m.suggestions[0]?.header])).toEqual([['event_type', 'what_happened']]);
    const fixed = await mappingRoute.POST(req('/api/dataset/mapping', { method: 'POST', body: JSON.stringify({ stageId: stage.stageId, mapping: { columns: { 'event_stream.csv': { what_happened: 'event_type' } } } }) }));
    const again = await body<StageResult>(fixed);
    expect(again.report.ok).toBe(true);
    expect(again.mapping).toEqual({ columns: { 'event_stream.csv': { what_happened: 'event_type' } } });
  });

  it('a .zip of the package works the same (macOS junk ignored)', async () => {
    const zip = zipSync({ ...Object.fromEntries(Object.entries(raw).map(([n, t]) => [`package/${n}`, strToU8(t)])), '__MACOSX/._hospitals.csv': strToU8('junk') });
    const { stage } = await upload({ 'judges.zip': zip });
    expect(stage.report.ok).toBe(true);
    expect(stage.files).toHaveLength(Object.keys(raw).length);
  });

  it('nothing usable is a 400', async () => {
    const form = new FormData();
    form.append('files', new File(['hello'], 'notes.txt'));
    const r = await datasetRoute.POST(new Request('http://localhost:3000/api/dataset', { method: 'POST', body: form }));
    expect(r.status).toBe(400);
  });
});

describe('activate and revert (lead PIN)', () => {
  it('activation needs the PIN; it swaps the dataset (view reflects it), reports a snapshot mismatch, clears the action log; revert restores data/raw', async () => {
    const before = await view();
    expect(before.dataset.source).toBe('raw');
    // A different package: the last 20 events are missing, so the replay no longer matches the snapshot.
    const lines = (raw['event_stream.csv'] ?? '').trimEnd().split(/\r?\n/);
    const truncated = lines.slice(0, lines.length - 20).join('\r\n') + '\r\n';
    const { stage } = await upload({ ...raw, 'event_stream.csv': truncated });
    expect(stage.canActivate).toBe(true);
    expect(stage.snapshot?.diffCount).toBeGreaterThan(0);

    const denied = await activate(stage.stageId, false);
    expect(denied.status).toBe(401);
    expect((await body(denied)).code).toBe('PIN_REQUIRED');

    const ok = await activate(stage.stageId);
    expect(ok.status).toBe(200);
    const after = await view();
    expect(after.dataset.source).toBe('upload');
    expect(after.dataset.key).not.toBe(before.dataset.key);
    expect(after.dataset.eventCount).toBe(before.dataset.eventCount - 20);
    expect(after.integrity.diffs).toBeGreaterThan(0);
    expect(after.logSeq).toBe(0);
    expect(after.dataset.previousLabel).toBe(before.dataset.label);

    const rv = await revertRoute.POST(req('/api/dataset/revert', { method: 'POST', cookie: cookie() }));
    expect(rv.status).toBe(200);
    const back = await view();
    expect(back.dataset.key).toBe(before.dataset.key);
    expect(back.integrity.diffs).toBe(0);
    expect(back.attention[0]?.id).toBe(before.attention[0]?.id);
  });

  it('the active dataset survives a restart (pointer in data/live)', async () => {
    const { stage } = await upload(raw);
    await activate(stage.stageId);
    const key = (await view()).dataset.key;
    disposeStore();
    expect((await view()).dataset.key).toBe(key);
    await revertRoute.POST(req('/api/dataset/revert', { method: 'POST', cookie: cookie() }));
  });
});
