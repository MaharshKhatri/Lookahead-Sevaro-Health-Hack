'use client';

import Link from 'next/link';
import { useState, type DragEvent } from 'react';
import type { ViewDTO } from '@/lib/dto';
import { etHms } from '@/lib/format';
import type { InjectResult } from '@/server/store';
import { LiveProvider, useLive } from './live';
import { TopBar } from './TopBar';
import { Button, Chip, Panel } from './ui';

/**
 * /inject: the live test (brief "What Teams Must Demonstrate" #8: "judges
 * will add new events in the same format ... Your system must update without
 * a restart"). Rows go to POST /api/events at the sim clock.
 */

const HEADER = 'event_id,event_time,ingested_at,consult_id,event_type,physician_id,hospital_id,description';

/** ISO-8601 with the ET offset of that instant, as event_stream.csv writes it. */
function isoEt(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const off = get('timeZoneName').replace('GMT', '') || '+00:00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${off}`;
}

function sampleRows(v: ViewDTO): string {
  const s = v.sample;
  const t = v.clock.nowMs + 60_000;
  const [e1, e2] = s.nextEventIds;
  const hospital = s.surgingHospitalId ?? v.coverage.rows[0]?.hospitalId ?? '';
  return [
    HEADER,
    `${e1},${isoEt(t)},${isoEt(t + 2_000)},${s.nextConsultId},consult_received,,${hospital},Stroke consult request received`,
    `${e2},${isoEt(t + 45_000)},${isoEt(t + 47_000)},${s.nextConsultId},consult_triaged,,${hospital},Consult triaged`,
  ].join('\n');
}

function Body() {
  const { view, clock, toast, refetch } = useLive();
  const [text, setText] = useState('');
  const [advance, setAdvance] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(InjectResult & { ok: boolean }) | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  if (view === null) return <p className="p-8 text-muted">Loading…</p>;

  /** A CSV file in event_stream format (with or without header) goes into the textarea for review, then Submit. */
  async function loadFile(f: File | undefined) {
    if (f === undefined) return;
    const text = await f.text();
    setText(text.replace(/^\uFEFF/, ''));
    setLoaded(`${f.name}: ${text.trim().split(/\r?\n/).length} lines loaded; review, then Submit rows`);
  }
  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDrag(false);
    void loadFile(e.dataTransfer.files[0]);
  };

  async function submit() {
    setBusy(true);
    try {
      const r = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });
      const b = (await r.json()) as InjectResult & { ok: boolean; code?: string; message?: string };
      if (!r.ok && b.code !== undefined) {
        toast('error', b.message ?? b.code);
        setResult(null);
        return;
      }
      setResult(b);
      toast(b.accepted.length > 0 ? 'ok' : 'error', `${b.accepted.length} accepted, ${b.duplicates.length} duplicate, ${b.rejected.length} rejected`);
      if (advance && b.knownFromMs !== null) await clock({ action: 'set', nowMs: b.knownFromMs });
      refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="scroll-thin grid flex-1 grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-3 overflow-y-auto p-3">
      <Panel title="Inject Sevaro events (event_stream.csv format)" right={<span className="num text-[13px] text-muted">sim clock {etHms(view.clock.nowMs)} ET</span>}>
        <div className="space-y-3 p-4">
          <p className="text-[14px] text-muted">
            Paste rows with or without the header. A blank <span className="num">ingested_at</span> is stamped with the sim clock. Rows dated after the clock become known when the clock reaches them (knowledge time); duplicates are reported, bad lines rejected
            with their line number. No restart.
          </p>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-3 py-2 text-[13px] ${drag ? 'border-accent bg-accent/10 text-text' : 'border-border text-muted'}`}
          >
            <span className="font-semibold text-text">Drop a CSV file</span> or click to choose (event_stream.csv format)
            <input type="file" accept=".csv,text/csv,text/plain" className="hidden" data-testid="inject-file" onChange={(e) => void loadFile(e.target.files?.[0])} />
            {loaded !== null && <span className="ml-auto text-ok">{loaded}</span>}
          </label>
          <textarea
            data-testid="inject-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={10}
            placeholder={HEADER}
            className="num w-full rounded-md border border-border bg-bg p-3 text-[13px] leading-relaxed text-text outline-none focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button tone="muted" testId="inject-sample" onClick={() => setText(sampleRows(view))} title="A stroke consult received and triaged at the surging hospital, 1 min after the sim clock">
              Insert sample
            </Button>
            <Button testId="inject-submit" disabled={busy || text.trim() === ''} onClick={() => void submit()}>
              {busy ? 'Submitting…' : 'Submit rows'}
            </Button>
            <label className="flex items-center gap-2 text-[13px] text-muted">
              <input type="checkbox" checked={advance} onChange={(e) => setAdvance(e.target.checked)} data-testid="inject-advance" />
              advance the sim clock to when these rows are known
            </label>
          </div>
          {view.sample.surgingHospitalName !== null && (
            <p className="text-[13px] text-muted">
              Sample: a new stroke consult <span className="num text-text">{view.sample.nextConsultId}</span> at the surging hospital ({view.sample.surgingHospitalName}), received and triaged one minute after the sim clock.
            </p>
          )}
        </div>
      </Panel>
      <Panel title="Result per line" right={result !== null && <Link href="/" className="text-[14px] font-semibold text-info underline" data-testid="inject-back">Back to the command center →</Link>}>
        <div className="space-y-2 p-4 text-[14px]" data-testid="inject-result">
          {result === null && <p className="text-muted">Nothing submitted yet.</p>}
          {result !== null && (
            <>
              <p className="text-muted">
                header {result.header}; applied at sim {etHms(result.nowMs)} ET
                {result.knownFromMs !== null && <> · known from {etHms(result.knownFromMs)} ET</>}
              </p>
              {result.accepted.map((a) => (
                <div key={`a${a.line}`} className="flex items-center gap-2">
                  <Chip tone="ok">LINE {a.line} ACCEPTED</Chip>
                  <span className="num">{a.eventId}</span>
                  <span className="text-muted">{a.eventType}</span>
                  <span className="num text-muted">
                    @ {etHms(a.eventTimeMs)} (ingested {etHms(a.ingestedAtMs)}
                    {a.ingestedAtDefaulted ? ', stamped' : ''})
                  </span>
                </div>
              ))}
              {result.duplicates.map((d) => (
                <div key={`d${d.line}`} className="flex items-center gap-2">
                  <Chip tone="warning">LINE {d.line} DUPLICATE</Chip>
                  <span className="num">{d.eventId}</span>
                  <span className="text-muted">{d.reason}</span>
                </div>
              ))}
              {result.rejected.map((r) => (
                <div key={`r${r.line}`} className="flex items-start gap-2">
                  <Chip tone="critical">LINE {r.line} REJECTED</Chip>
                  <span className="text-muted">{r.reason}</span>
                </div>
              ))}
              {result.warnings.map((w) => (
                <div key={w} className="text-[13px] text-warning">
                  warning: {w}
                </div>
              ))}
            </>
          )}
        </div>
      </Panel>
    </main>
  );
}

export function InjectView({ initial }: { readonly initial: ViewDTO | null }) {
  return (
    <LiveProvider initial={initial}>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <Body />
      </div>
    </LiveProvider>
  );
}
