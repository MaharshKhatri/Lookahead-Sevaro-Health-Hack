import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffSnapshot, ingestDataset, replay, snapshotAsOfMs, toSnapshotConsultRows, toSnapshotPhysicianRows, type Dataset } from '../src';
import { ingestDir, loadDataset } from '../src/data/loaders';
import { DATA_DIR } from './helpers';

/**
 * OQ-45 schema-adaptive ingestion. Brief "What Teams Must Demonstrate" #8:
 * "judges will add new events in the same format"; the brief prints its own
 * tables with headers such as "Event time" and "Phys.", which must ingest.
 */

const raw: Record<string, string> = Object.fromEntries(readdirSync(DATA_DIR).filter((n) => n.endsWith('.csv')).map((n) => [n, readFileSync(join(DATA_DIR, n), 'utf8')]));
const original = loadDataset(DATA_DIR);

const replaceHeader = (text: string, header: string) => header + text.slice(text.search(/\r?\n/));
const snapshotSummary = (d: Dataset) => {
  const at = snapshotAsOfMs(d) ?? 0;
  const st = replay(d, at);
  return d.snapshot === null ? null : diffSnapshot({ physicians: toSnapshotPhysicianRows(st), consults: toSnapshotConsultRows(st) }, d.snapshot);
};

describe('ingestDataset: the original package', () => {
  it('ingests unchanged: every file by name, every header exact, same dataset as loadDataset, 8/8 and 18/18', () => {
    const r = ingestDataset(raw);
    expect(r.report.ok).toBe(true);
    expect(r.report.files.every((f) => f.detectedBy === 'name' && f.mapped.every((m) => m.method === 'exact'))).toBe(true);
    expect(r.dataset?.events).toEqual(original.events);
    expect(r.dataset?.credentials).toEqual(original.credentials);
    expect(r.report.snapshotLabel).toBe('1820');
    const d = snapshotSummary(r.dataset as Dataset);
    expect(d?.summary).toEqual({ physicians: '8/8 rows match', consults: '18/18 rows match' });
    expect(d?.diffs).toHaveLength(0);
  });

  it('ingestDir reads the same package from a directory', () => {
    expect(ingestDir(DATA_DIR).report.ok).toBe(true);
  });
});

describe('ingestDataset: renamed headers (brief event-stream excerpt headers)', () => {
  const brief = 'Event,Event time,Ingested,Consult,Type,Phys.,Hosp.,Description';
  const texts = { ...raw, 'event_stream.csv': replaceHeader(raw['event_stream.csv'] ?? '', brief) };

  it('maps each header with a reported method and parses to the identical events', () => {
    const r = ingestDataset(texts);
    expect(r.report.ok).toBe(true);
    const f = r.report.files.find((x) => x.kind === 'events');
    expect(f?.mapped).toEqual([
      { source: 'Event', column: 'event_id', method: 'alias' },
      { source: 'Event time', column: 'event_time', method: 'normalized' },
      { source: 'Ingested', column: 'ingested_at', method: 'alias' },
      { source: 'Consult', column: 'consult_id', method: 'alias' },
      { source: 'Type', column: 'event_type', method: 'alias' },
      { source: 'Phys.', column: 'physician_id', method: 'alias' },
      { source: 'Hosp.', column: 'hospital_id', method: 'alias' },
      { source: 'Description', column: 'description', method: 'normalized' },
    ]);
    expect(r.dataset?.events).toEqual(original.events);
    expect(snapshotSummary(r.dataset as Dataset)?.diffs).toHaveLength(0);
  });

  it('a renamed file is recognised from its headers', () => {
    const { 'event_stream.csv': ev, ...rest } = texts;
    const r = ingestDataset({ ...rest, 'judge events.csv': ev ?? '' });
    expect(r.report.files.find((x) => x.source === 'judge events.csv')).toMatchObject({ kind: 'events', detectedBy: 'headers', canonicalName: 'event_stream.csv' });
    expect(r.report.ok).toBe(true);
  });

  it('snapshot tables with the brief\'s headers and a labelled odd file name ingest', () => {
    const { 'snapshot_physicians_1820.csv': sp, ...rest } = raw;
    const header = 'ID,Physician,Shift (ET),Self-reported,Agent,Derived state,Cons.,Calls,Open,Min to end';
    const r = ingestDataset({ ...rest, 'physicians at 1820.csv': replaceHeader(sp ?? '', header) });
    expect(r.report.files.find((x) => x.source === 'physicians at 1820.csv')).toMatchObject({ kind: 'snapshotPhysicians', detectedBy: 'headers', canonicalName: 'snapshot_physicians_1820.csv' });
    expect(r.report.ok).toBe(true);
    expect(snapshotSummary(r.dataset as Dataset)?.summary.physicians).toBe('8/8 rows match');
  });
});

describe('ingestDataset: what cannot be ingested is reported, never guessed', () => {
  it('a missing required column is a clear error with the closest headers as suggestions; a mapping.json override fixes it', () => {
    const texts = { ...raw, 'event_stream.csv': replaceHeader(raw['event_stream.csv'] ?? '', 'event_id,event_time,ingested_at,consult_id,evnt_kind,physician_id,hospital_id,description') };
    const r = ingestDataset(texts);
    expect(r.report.ok).toBe(false);
    expect(r.dataset).toBeNull();
    const f = r.report.files.find((x) => x.kind === 'events');
    expect(f?.missing).toEqual([{ column: 'event_type', suggestions: [{ header: 'evnt_kind', distance: expect.any(Number) }] }]);
    expect(f?.unmapped).toEqual(['evnt_kind']);
    const fixed = ingestDataset(texts, { columns: { events: { evnt_kind: 'event_type' } } });
    expect(fixed.report.ok).toBe(true);
    expect(fixed.report.files.find((x) => x.kind === 'events')?.mapped.find((m) => m.source === 'evnt_kind')?.method).toBe('override');
  });

  it('bad rows are listed with their line numbers (all of them, not just the first)', () => {
    const lines = (raw['event_stream.csv'] ?? '').split('\n');
    lines[4] = (lines[4] ?? '').replace('physician_status_changed', 'shift_begun');
    lines[9] = (lines[9] ?? '').replace('2026-03-17T07:19:53-04:00', '2026-03-17 07:19');
    const r = ingestDataset({ ...raw, 'event_stream.csv': lines.join('\n') });
    expect(r.report.ok).toBe(false);
    const f = r.report.files.find((x) => x.kind === 'events');
    expect(f?.rowErrors.map((e) => e.line)).toEqual([5, 10]);
    expect(f?.rowErrors[0]?.message).toContain('shift_begun');
  });

  it('a missing required file is listed', () => {
    const rest = Object.fromEntries(Object.entries(raw).filter(([name]) => name !== 'hospitals.csv'));
    const r = ingestDataset(rest);
    expect(r.report.ok).toBe(false);
    expect(r.report.missingFiles).toEqual(['hospitals']);
  });
});

describe('credentialing matrix headers without the SYN- prefix (brief: "Column headers are hospital IDs without the SYN- prefix")', () => {
  it('bare numeric hospital columns are matched to hospitals.csv ids', () => {
    const cred = raw['credentialing_matrix.csv'] ?? '';
    const header = (cred.split(/\r?\n/)[0] ?? '').split(',').map((h) => h.replace(/^SYN-/, '')).join(',');
    const r = ingestDataset({ ...raw, 'credentialing_matrix.csv': replaceHeader(cred, header) });
    expect(r.report.ok).toBe(true);
    expect(r.report.files.find((x) => x.kind === 'credentials')?.mapped.filter((m) => m.method === 'hospital_suffix')).toHaveLength(12);
    expect(r.dataset?.credentials).toEqual(original.credentials);
  });
});

describe('ingestDir with mapping.json', () => {
  it('applies overrides from the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
    for (const [n, t] of Object.entries(raw)) writeFileSync(join(dir, n), n === 'hospitals.csv' ? replaceHeader(t, 'hid,hospital_name,local_timezone,coverage_tier') : t);
    expect(ingestDir(dir).report.ok).toBe(false);
    writeFileSync(join(dir, 'mapping.json'), JSON.stringify({ columns: { 'hospitals.csv': { hid: 'hospital_id' } } }));
    expect(ingestDir(dir).report.ok).toBe(true);
  });
});
