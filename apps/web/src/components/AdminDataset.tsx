'use client';

import Link from 'next/link';
import { useState, type DragEvent } from 'react';
import type { IngestFileReport, IngestMapping } from '@lookahead/engine';
import type { ViewDTO } from '@/lib/dto';
import { plainError } from '@/lib/errors';
import type { StageResult } from '@/server/dataset';
import { LiveProvider, useLive } from './live';
import { PinPrompt, TopBar } from './TopBar';
import { Button, Chip, Panel, cx } from './ui';

/**
 * /admin/dataset: dataset swap for judging (Session 7). Upload CSVs or a zip,
 * read the engine's ingest report (OQ-45), fix headers with a mapping, check
 * the replay against the upload's own snapshot, then Activate (lead PIN).
 * Revert restores the previous dataset in one click.
 */

const METHOD_TONE = { exact: 'ok', override: 'accent', normalized: 'info', alias: 'info', prefix: 'warning', hospital_suffix: 'info' } as const;

function FileCard({ f, choice, setChoice }: { readonly f: IngestFileReport; readonly choice: Record<string, string>; readonly setChoice: (column: string, header: string) => void }) {
  const bad = f.missing.length > 0 || f.rowErrors.length > 0;
  return (
    <div data-testid="ingest-file" data-kind={f.kind ?? 'none'} className={cx('rounded-lg border p-3', f.kind === null ? 'border-border bg-raised/30' : bad ? 'border-critical/60 bg-critical/5' : 'border-ok/40 bg-ok/5')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="num text-[14px] font-semibold">{f.source}</span>
        <span className="text-muted">→</span>
        {f.kind === null ? <Chip tone="muted">IGNORED</Chip> : <Chip tone={bad ? 'critical' : 'ok'}>{f.kind}</Chip>}
        {f.detectedBy !== null && <span className="text-[12px] text-muted">by {f.detectedBy}</span>}
        {f.canonicalName !== null && f.canonicalName !== f.source && <span className="num text-[12px] text-muted">as {f.canonicalName}</span>}
        <span className="num ml-auto text-[12px] text-muted">{f.rows} rows</span>
      </div>
      {f.mapped.some((m) => m.method !== 'exact') && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {f.mapped
            .filter((m) => m.method !== 'exact')
            .map((m) => (
              <span key={m.source} className="text-[12px]">
                <span className="num">&quot;{m.source}&quot;</span> → <span className="num text-text">{m.column}</span> <Chip tone={METHOD_TONE[m.method]}>{m.method}</Chip>
              </span>
            ))}
        </div>
      )}
      {f.mapped.length > 0 && f.mapped.every((m) => m.method === 'exact') && <div className="mt-1 text-[12px] text-muted">all {f.mapped.length} columns match exactly</div>}
      {f.unmapped.length > 0 && f.kind !== null && <div className="mt-1 text-[12px] text-muted">unmapped headers (ignored): {f.unmapped.map((u) => `"${u}"`).join(', ')}</div>}
      {f.missing.map((m) => (
        <div key={m.column} className="mt-2 flex flex-wrap items-center gap-2 text-[13px]" data-testid="missing-column">
          <Chip tone="critical">MISSING</Chip>
          <span className="num font-semibold">{m.column}</span>
          <span className="text-muted">map from</span>
          <select
            value={choice[m.column] ?? m.suggestions[0]?.header ?? ''}
            onChange={(e) => setChoice(m.column, e.target.value)}
            className="rounded border border-border bg-bg px-2 py-0.5 text-[13px]"
            data-testid={`map-${m.column}`}
          >
            <option value="">(choose a header)</option>
            {f.unmapped.map((u) => (
              <option key={u} value={u}>
                {u}
                {m.suggestions[0]?.header === u ? ' (closest)' : ''}
              </option>
            ))}
          </select>
        </div>
      ))}
      {f.rowErrors.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[12px]" data-testid="row-errors">
          {f.rowErrors.map((e) => (
            <li key={e.line}>
              <span className="num text-critical">line {e.line}</span> <span className="text-muted">{e.message}</span>
            </li>
          ))}
          {f.moreRowErrors > 0 && <li className="text-muted">… and {f.moreRowErrors} more</li>}
        </ul>
      )}
      {f.notes.map((n) => (
        <div key={n} className="mt-1 text-[12px] text-warning">
          {n}
        </div>
      ))}
    </div>
  );
}

function Report({ stage, onRemap, onActivate, busy }: { readonly stage: StageResult; readonly onRemap: (m: IngestMapping) => void; readonly onActivate: () => void; readonly busy: boolean }) {
  const [choice, setChoice] = useState<Record<string, Record<string, string>>>({});
  const r = stage.report;
  const snap = stage.snapshot;
  const needsMapping = r.files.some((f) => f.missing.length > 0);
  const applyMapping = () => {
    const columns: Record<string, Record<string, string>> = { ...(stage.mapping?.columns ?? {}) };
    for (const f of r.files) {
      if (f.kind === null) continue;
      for (const m of f.missing) {
        const header = choice[f.source]?.[m.column] ?? m.suggestions[0]?.header ?? '';
        if (header !== '') columns[f.source] = { ...(columns[f.source] ?? {}), [header]: m.column };
      }
    }
    onRemap({ ...(stage.mapping ?? {}), columns });
  };
  return (
    <div className="space-y-3" data-testid="ingest-report" data-ok={r.ok}>
      <div className="flex flex-wrap items-center gap-3">
        {r.ok ? <Chip tone="ok">INGESTS</Chip> : <Chip tone="critical">DOES NOT INGEST</Chip>}
        <span className="text-[14px] text-muted">
          {stage.files.length} files staged{stage.eventCount !== null && <> · {stage.eventCount} events</>}
          {r.snapshotLabel !== null && <> · snapshot {r.snapshotLabel}</>}
        </span>
        <span className="ml-auto flex gap-2">
          {needsMapping && (
            <Button tone="muted" onClick={applyMapping} testId="apply-mapping" disabled={busy}>
              Apply mapping &amp; re-ingest
            </Button>
          )}
          <Button tone="ok" testId="activate-dataset" disabled={!stage.canActivate || busy} onClick={onActivate}>
            Activate this dataset
          </Button>
        </span>
      </div>
      {snap !== null &&
        (snap.diffCount === 0 ? (
          <div className="rounded-lg border border-ok/60 bg-ok/10 p-3 text-[15px] text-ok" data-testid="snapshot-check">
            Replay matches your snapshot {snap.label}: <span className="num font-semibold">{snap.physicians}</span> physicians · <span className="num font-semibold">{snap.consults}</span> consults · 0 cell diffs
          </div>
        ) : (
          <div className="rounded-lg border border-critical/70 bg-critical/15 p-3 text-[15px] text-critical" data-testid="snapshot-check">
            Replay differs from your snapshot: <span className="num font-semibold">{snap.diffCount}</span> cells ({snap.physicians} physicians, {snap.consults} consults). You can still activate; details on{' '}
            <Link href="/integrity" className="underline">
              /integrity
            </Link>{' '}
            after activation.
            <ul className="mt-2 max-h-[160px] overflow-auto text-[12px] text-text/80">
              {snap.diffs.slice(0, 30).map((d) => (
                <li key={`${d.table}|${d.key}|${d.column}`} className="num">
                  {d.table} {d.key} {d.column}: expected &quot;{d.expected}&quot;, replay &quot;{d.actual}&quot;
                </li>
              ))}
            </ul>
          </div>
        ))}
      {snap === null && r.ok && <div className="text-[13px] text-muted">No snapshot files in this upload: nothing to compare the replay against.</div>}
      {r.missingFiles.length > 0 && (
        <div className="text-[14px] text-critical" data-testid="missing-files">
          Missing required file(s): {r.missingFiles.join(', ')}
        </div>
      )}
      {r.errors.map((e) => (
        <div key={e} className="text-[13px] text-critical">
          {e}
        </div>
      ))}
      <div className="grid grid-cols-2 gap-2">
        {r.files.map((f) => (
          <FileCard key={f.source} f={f} choice={choice[f.source] ?? {}} setChoice={(column, header) => setChoice((c) => ({ ...c, [f.source]: { ...(c[f.source] ?? {}), [column]: header } }))} />
        ))}
      </div>
      {r.warnings.length > 0 && (
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer">{r.warnings.length} data warnings (non-fatal)</summary>
          <ul className="mt-1 space-y-0.5">
            {r.warnings.slice(0, 100).map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Body() {
  const { view, toast, refetch } = useLive();
  const [stage, setStage] = useState<StageResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinThen, setPinThen] = useState<null | (() => void)>(null);
  const [drag, setDrag] = useState(false);

  async function call<T>(url: string, init: RequestInit, retry?: () => void): Promise<T | null> {
    setBusy(true);
    try {
      const r = await fetch(url, init);
      const b = (await r.json()) as T & { ok?: boolean; code?: string; message?: string };
      if (r.status === 401 && b.code === 'PIN_REQUIRED' && retry !== undefined) {
        setPinThen(() => retry);
        return null;
      }
      if (!r.ok) {
        toast('error', plainError(b.code, b.message));
        return null;
      }
      return b;
    } finally {
      setBusy(false);
    }
  }

  async function upload(files: FileList | File[]) {
    const form = new FormData();
    for (const f of Array.from(files)) form.append('files', f, f.name);
    const r = await call<StageResult>('/api/dataset', { method: 'POST', body: form });
    if (r !== null) setStage(r);
  }

  async function remap(mapping: IngestMapping) {
    if (stage === null) return;
    const r = await call<StageResult>('/api/dataset/mapping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stageId: stage.stageId, mapping }) });
    if (r !== null) setStage(r);
  }

  async function activate() {
    if (stage === null) return;
    const r = await call<{ active: { label: string } }>('/api/dataset/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stageId: stage.stageId }) }, () => void activate());
    if (r !== null) {
      toast('ok', `Activated: ${r.active.label}. Action log cleared; clock at the new reference time.`);
      refetch();
    }
  }

  async function revert() {
    const r = await call<{ active: { label: string } }>('/api/dataset/revert', { method: 'POST' }, () => void revert());
    if (r !== null) {
      toast('ok', `Reverted to ${r.active.label}.`);
      refetch();
    }
  }

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files);
  };

  if (view === null) return <p className="p-8 text-muted">Loading…</p>;
  const ds = view.dataset;
  return (
    <main className="scroll-thin grid flex-1 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 overflow-y-auto p-3">
      <div className="space-y-3">
        <Panel title="Active dataset">
          <div className="space-y-1.5 p-4 text-[14px]" data-testid="active-dataset" data-key={ds.key}>
            <div className="text-[18px] font-semibold">{ds.label}</div>
            <div className="text-muted">
              <span className="num">{ds.key}</span> · {ds.eventCount} events · snapshot {ds.snapshotLabel ?? 'none'}
            </div>
            <div className="text-muted">
              replay vs snapshot:{' '}
              {view.integrity.diffs === 0 ? (
                <span className="text-ok">
                  {view.integrity.physicians}; {view.integrity.consults}
                </span>
              ) : (
                <span className="text-critical">{view.integrity.diffs} cells differ</span>
              )}
            </div>
            <div className="text-muted">storage: {ds.store}</div>
            {ds.previousLabel !== null && (
              <div className="flex items-center gap-2 pt-2">
                <Button tone="muted" testId="revert-dataset" disabled={busy} onClick={() => void revert()}>
                  Revert to {ds.previousLabel}
                </Button>
              </div>
            )}
          </div>
        </Panel>
        <Panel title="Upload a data package">
          <div className="space-y-3 p-4">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
              className={cx('flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center', drag ? 'border-accent bg-accent/10' : 'border-border')}
            >
              <span className="text-[16px] font-semibold">Drop CSV files or a .zip here</span>
              <span className="mt-1 text-[13px] text-muted">or click to choose · event_stream, hospitals, rosters, credentialing, baseline, coverage, snapshots</span>
              <input type="file" multiple accept=".csv,.zip,text/csv,application/zip" className="hidden" data-testid="dataset-files" onChange={(e) => e.target.files !== null && void upload(e.target.files)} />
            </label>
            <p className="text-[12px] text-muted">
              Headers may differ from ours (the brief&apos;s own table headers such as &quot;Event time&quot; or &quot;Phys.&quot; are understood). Anything the engine cannot map is listed with suggestions; nothing is guessed silently (OQ-45).
            </p>
          </div>
        </Panel>
      </div>
      <Panel title="Ingest report">
        <div className="p-4">{stage === null ? <p className="text-muted">Upload a package to see how it maps.</p> : <Report stage={stage} onRemap={(m) => void remap(m)} onActivate={() => void activate()} busy={busy} />}</div>
      </Panel>
      {pinThen !== null && (
        <PinPrompt
          onDone={() => {
            const next = pinThen;
            setPinThen(null);
            next();
          }}
          onCancel={() => setPinThen(null)}
        />
      )}
    </main>
  );
}

export function AdminDataset({ initial }: { readonly initial: ViewDTO | null }) {
  return (
    <LiveProvider initial={initial}>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <Body />
      </div>
    </LiveProvider>
  );
}
