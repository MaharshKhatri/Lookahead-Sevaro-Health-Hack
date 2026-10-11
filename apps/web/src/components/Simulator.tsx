'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewDTO } from '@/lib/dto';
import { etHms } from '@/lib/format';
import type { SimKind, SimSendResult, SinkEntry } from '@/server/simulator';
import type { IngestReportDTO } from '@/server/v1';
import { LiveProvider, useLive } from './live';
import { TopBar } from './TopBar';
import { Button, Chip, Panel, cx } from './ui';

/**
 * /simulator (sprint B1, demo only; LOOKAHEAD-DEFINED): an upstream event
 * feed stand-in. Each button asks the server to build one event_stream.csv row
 * from the current snapshot and post it, signed, through POST /api/v1/events.
 * The right column shows what was sent and what came back, and the inbound
 * webhook deliveries the dispatcher posted to the dev sink. Timings: sent ->
 * first SSE message carrying the new store version -> view refetched at that
 * version -> first webhook envelope with version >= it.
 */

const STATUSES = ['Available', 'Temporarily Unavailable'] as const;
const OUT_LOG_SIZE = 50;
const SINK_POLL_MS = 1_500;

interface Action {
  readonly kind: SimKind;
  readonly label: string;
  readonly sends: string;
  readonly uses: readonly ('hospital' | 'physician' | 'status')[];
}

// Event types as in data/raw/event_stream.csv; the row itself is built server-side.
const ACTIONS: readonly Action[] = [
  { kind: 'stroke_consult', label: 'New stroke consult', sends: 'consult_received at the chosen hospital', uses: ['hospital'] },
  { kind: 'physician_status', label: 'Physician status', sends: 'physician_status_changed (self-reported status)', uses: ['physician', 'status'] },
  { kind: 'camera_active', label: 'Camera active without session', sends: 'camera_active with no video session', uses: ['physician', 'hospital'] },
  { kind: 'heartbeat_lost', label: 'Agent heartbeat lost', sends: 'agent_heartbeat_lost', uses: ['physician'] },
  { kind: 'note_signed', label: 'Note signed', sends: 'note_signed on an open assigned consult', uses: ['physician'] },
  { kind: 'routing_failed', label: 'Routing attempt failed', sends: 'routing_attempt_failed on an unassigned open consult', uses: ['hospital'] },
  { kind: 'duplicate', label: 'Duplicate event', sends: 'resends the last row byte-for-byte', uses: [] },
  { kind: 'late', label: 'Late event', sends: 'consult_received with event_time 7 min before ingested_at', uses: ['hospital'] },
];

type ErrorReport = { readonly ok: false; readonly code: string; readonly message: string };

interface OutRow {
  readonly id: number;
  readonly clientSentAtMs: number;
  readonly result: SimSendResult | null;
  readonly error: string | null;
  sseAtMs: number | null;
  viewAtMs: number | null;
}

const isIngest = (r: SimSendResult['report']): r is IngestReportDTO => 'accepted' in r;
const ms = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.max(0, Math.round(b - a)));

function reportChips(r: SimSendResult) {
  if (!isIngest(r.report)) {
    const e = r.report as ErrorReport;
    return <Chip tone="critical">{`${r.status} ${e.code}`}</Chip>;
  }
  const x = r.report;
  return (
    <>
      <Chip tone={r.status === 200 ? 'ok' : 'warning'}>{`HTTP ${r.status}`}</Chip>
      <Chip tone={x.accepted > 0 ? 'ok' : 'muted'}>{`accepted ${x.accepted}`}</Chip>
      {x.duplicates > 0 && <Chip tone="info">{`duplicates ${x.duplicates}`}</Chip>}
      {x.late > 0 && <Chip tone="warning">{`late ${x.late}`}</Chip>}
      {x.rejected.length > 0 && <Chip tone="critical">{`rejected ${x.rejected.length}`}</Chip>}
      <Chip tone={x.signature === 'verified' ? 'ok' : 'muted'}>{x.signature === 'verified' ? 'signature verified' : 'unsigned (demo)'}</Chip>
    </>
  );
}

function Timing({ row, webhookAtMs }: { readonly row: OutRow; readonly webhookAtMs: number | null }) {
  const r = row.result;
  if (r === null) return null;
  const accepted = isIngest(r.report) && r.report.accepted > 0;
  const step = (label: string, v: number | null, waiting: string) => (
    <span className="whitespace-nowrap">
      {label} <span className="num text-text">{v === null ? waiting : `+${v} ms`}</span>
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted" data-testid="sim-timing">
      {step('ingest', Math.round(r.latencyMs), '')}
      <span aria-hidden>→</span>
      {step('SSE', ms(row.clientSentAtMs, row.sseAtMs), accepted ? 'waiting' : 'no change')}
      <span aria-hidden>→</span>
      {step('view updated', ms(row.clientSentAtMs, row.viewAtMs), accepted ? 'waiting' : 'no change')}
      <span aria-hidden>→</span>
      {step('webhook received', ms(r.sentAtMs, webhookAtMs), accepted ? 'waiting' : 'no change')}
    </div>
  );
}

function OutLogRow({ row, webhookAtMs }: { readonly row: OutRow; readonly webhookAtMs: number | null }) {
  const r = row.result;
  return (
    <li data-testid="sim-out-row" data-status={r?.status ?? 'error'} data-accepted={r !== null && isIngest(r.report) ? r.report.accepted : 0} className="border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="num text-[13px] text-muted">{etHms(row.clientSentAtMs)}</span>
        <span className="text-[14px] font-semibold">{r?.summary ?? 'send failed'}</span>
        <span className="ml-auto flex flex-wrap gap-1">{r !== null ? reportChips(r) : <Chip tone="critical">error</Chip>}</span>
      </div>
      {row.error !== null && <p className="mt-1 text-[13px] text-critical">{row.error}</p>}
      {r !== null && (
        <>
          <Timing row={row} webhookAtMs={webhookAtMs} />
          <div className="mt-1 text-[12px] text-muted">
            x-lookahead-signature:{' '}
            <span className="num break-all text-text" data-testid="sim-signature">
              {r.signatureHeader ?? 'none (no LOOKAHEAD_INGEST_SECRET; accepted unsigned because DEMO_MODE is on)'}
            </span>
          </div>
          <pre className="num mt-1 overflow-x-auto rounded border border-border bg-bg p-2 text-[11px] leading-snug text-text" data-testid="sim-payload">
            {r.payload}
          </pre>
          <details className="mt-1">
            <summary className="cursor-pointer text-[12px] text-muted">IngestReport</summary>
            <pre className="num overflow-x-auto rounded border border-border bg-bg p-2 text-[11px] leading-snug" data-testid="sim-report">
              {JSON.stringify(r.report, null, 2)}
            </pre>
          </details>
        </>
      )}
    </li>
  );
}

function WebhookRow({ e }: { readonly e: SinkEntry }) {
  const b = typeof e.body === 'object' && e.body !== null ? (e.body as { types?: unknown; event?: unknown }) : null;
  const types = Array.isArray(b?.types) ? (b.types as unknown[]).map(String).join(', ') : '';
  return (
    <li data-testid="sim-webhook-row" data-version={e.version ?? ''} className="border-b border-border px-4 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="num text-muted">{etHms(e.receivedAtMs)}</span>
        <span className="font-semibold">{typeof b?.event === 'string' ? b.event : 'delivery'}</span>
        {e.version !== null && <span className="num text-muted">v{e.version}</span>}
        {types !== '' && <span className="text-muted">{types}</span>}
        <span className="ml-auto">
          {e.verified === null ? <Chip tone="muted">unsigned</Chip> : e.verified ? <Chip tone="ok">signature verified</Chip> : <Chip tone="critical">signature mismatch</Chip>}
        </span>
      </div>
      <details>
        <summary className="cursor-pointer text-[12px] text-muted">body</summary>
        <pre className="num overflow-x-auto rounded border border-border bg-bg p-2 text-[11px] leading-snug">{typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2)}</pre>
      </details>
    </li>
  );
}

function SimulatorInner() {
  const { view } = useLive();
  const hospitals = view === null ? [] : [...view.forecast.hospitals].sort((a, b) => a.riskRank - b.riskRank);
  const physicians = view?.physicians ?? [];
  const [hospitalId, setHospitalId] = useState<string>('');
  const [physicianId, setPhysicianId] = useState<string>('');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>(STATUSES[1]);
  const [busy, setBusy] = useState<SimKind | null>(null);
  const [rows, setRows] = useState<OutRow[]>([]);
  const [sink, setSink] = useState<readonly SinkEntry[]>([]);
  const [sinkError, setSinkError] = useState<string | null>(null);
  const nextId = useRef(1);
  const sse = useRef<{ atMs: number; version: number }[]>([]);
  const views = useRef<{ atMs: number; version: number }[]>([]);

  // Default selections: the top-surge hospital (forecast riskRank 1) and the first on-shift physician.
  const topHospital = hospitals[0]?.hospitalId ?? '';
  const firstPhysician = physicians[0]?.physicianId ?? '';
  useEffect(() => {
    if (hospitalId === '' && topHospital !== '') setHospitalId(topHospital);
  }, [hospitalId, topHospital]);
  useEffect(() => {
    if (physicianId === '' && firstPhysician !== '') setPhysicianId(firstPhysician);
  }, [physicianId, firstPhysician]);

  const stamp = useCallback((key: 'sseAtMs' | 'viewAtMs', list: { atMs: number; version: number }[]) => {
    setRows((rs) => {
      let changed = false;
      const next = rs.map((r) => {
        if (r.result === null || r[key] !== null) return r;
        const v = r.result.version;
        const hit = list.find((x) => x.version >= v && x.atMs >= r.clientSentAtMs);
        if (hit === undefined) return r;
        changed = true;
        return { ...r, [key]: hit.atMs };
      });
      return changed ? next : rs;
    });
  }, []);

  // Own SSE subscription: the first message carrying the new version after a send.
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (m: MessageEvent<string>) => {
      try {
        const d = JSON.parse(m.data) as { version?: number };
        if (typeof d.version !== 'number') return;
        sse.current = [...sse.current.slice(-199), { atMs: Date.now(), version: d.version }];
        stamp('sseAtMs', sse.current);
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, [stamp]);

  // The Lookahead view (refetched by LiveProvider on SSE) reaching the new version.
  const viewVersion = view?.version ?? null;
  useEffect(() => {
    if (viewVersion === null) return;
    views.current = [...views.current.slice(-199), { atMs: Date.now(), version: viewVersion }];
    stamp('viewAtMs', views.current);
  }, [viewVersion, stamp]);

  // Inbound webhook log: poll the dev sink.
  useEffect(() => {
    let stopped = false;
    const load = () =>
      fetch('/api/simulator/webhook-sink', { cache: 'no-store' })
        .then(async (r) => {
          if (stopped) return;
          if (!r.ok) {
            setSinkError(`webhook sink answered ${r.status}`);
            return;
          }
          setSinkError(null);
          setSink(((await r.json()) as { entries: SinkEntry[] }).entries);
        })
        .catch(() => setSinkError('webhook sink unreachable'));
    void load();
    const t = setInterval(() => void load(), SINK_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  const send = async (a: Action) => {
    setBusy(a.kind);
    const clientSentAtMs = Date.now();
    const body: Record<string, string> = { kind: a.kind };
    if (a.uses.includes('hospital') && hospitalId !== '') body.hospitalId = hospitalId;
    if (a.uses.includes('physician') && physicianId !== '') body.physicianId = physicianId;
    if (a.uses.includes('status')) body.status = status;
    let row: OutRow;
    try {
      const r = await fetch('/api/simulator/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = (await r.json()) as SimSendResult | ErrorReport;
      row =
        'payload' in j
          ? { id: nextId.current++, clientSentAtMs, result: j, error: null, sseAtMs: null, viewAtMs: null }
          : { id: nextId.current++, clientSentAtMs, result: null, error: `${r.status} ${j.code}: ${j.message}`, sseAtMs: null, viewAtMs: null };
    } catch (e) {
      row = { id: nextId.current++, clientSentAtMs, result: null, error: e instanceof Error ? e.message : String(e), sseAtMs: null, viewAtMs: null };
    }
    setRows((rs) => [row, ...rs].slice(0, OUT_LOG_SIZE));
    stamp('sseAtMs', sse.current);
    stamp('viewAtMs', views.current);
    setBusy(null);
  };

  const webhookFor = (row: OutRow): number | null => {
    const r = row.result;
    if (r === null) return null;
    const hits = sink.filter((e) => e.version !== null && e.version >= r.version && e.receivedAtMs >= r.sentAtMs);
    return hits.length === 0 ? null : Math.min(...hits.map((e) => e.receivedAtMs));
  };

  const sel = 'mt-1 w-full rounded-md border border-border bg-bg p-1.5 text-[14px]';
  return (
    <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[380px_minmax(0,1fr)]" data-testid="simulator">
      <div className="flex flex-col gap-4">
        <Panel title="Send upstream events">
          <div className="flex flex-col gap-3 p-4">
            <label className="text-[13px] text-muted">
              Hospital
              <select data-testid="sim-hospital" className={sel} value={hospitalId} onChange={(e) => setHospitalId(e.target.value)}>
                {hospitals.map((h) => (
                  <option key={h.hospitalId} value={h.hospitalId}>
                    {`${h.hospitalName} (${h.hospitalId})${h.hospitalId === topHospital ? ' · top surge risk' : ''}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[13px] text-muted">
              Physician (on shift)
              <select data-testid="sim-physician" className={sel} value={physicianId} onChange={(e) => setPhysicianId(e.target.value)}>
                {physicians.map((p) => (
                  <option key={p.physicianId} value={p.physicianId}>
                    {`${p.name} (${p.physicianId}) · ${p.derivedState}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[13px] text-muted">
              Self-reported status
              <select data-testid="sim-status" className={sel} value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <ul className="flex flex-col gap-2">
              {ACTIONS.map((a) => (
                <li key={a.kind} className="flex items-center gap-3">
                  <Button testId={`sim-send-${a.kind}`} tone={a.kind === 'stroke_consult' ? 'accent' : 'muted'} disabled={busy !== null || view === null} onClick={() => void send(a)} className="w-[220px] text-left">
                    {a.kind === 'physician_status' ? `Status → ${status}` : a.label}
                  </Button>
                  <span className="text-[12px] leading-tight text-muted">{a.sends}</span>
                </li>
              ))}
            </ul>
            <p className="text-[12px] leading-snug text-muted">
              Rows are built on the server from the current snapshot at the sim clock{view === null ? '' : ` (${etHms(view.clock.nowMs)} ET)`}, signed there when an ingest secret is configured, and posted through the same POST /api/v1/events handler a partner integration uses. Demo only.
            </p>
          </div>
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Outgoing requests" right={<span className="num text-[12px] text-muted">{rows.length}</span>}>
          {rows.length === 0 ? (
            <p className="p-4 text-[14px] text-muted">Nothing sent yet.</p>
          ) : (
            <ul data-testid="sim-out-log" className="max-h-[52vh] overflow-y-auto">
              {rows.map((r) => (
                <OutLogRow key={r.id} row={r} webhookAtMs={webhookFor(r)} />
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Inbound webhooks (dev sink, last 50)" right={sinkError !== null ? <Chip tone="warning">{sinkError}</Chip> : <span className="num text-[12px] text-muted">{sink.length}</span>}>
          <ul data-testid="sim-webhook-log" className={cx('max-h-[36vh] overflow-y-auto', sink.length === 0 && 'min-h-[48px]')}>
            {sink.length === 0 && <li className="p-4 text-[14px] text-muted">No deliveries received yet.</li>}
            {sink.map((e) => (
              <WebhookRow key={`${e.receivedAtMs}-${e.version ?? 'x'}-${e.signature ?? ''}`} e={e} />
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

export function Simulator({ initial, enabled }: { readonly initial: ViewDTO | null; readonly enabled: boolean }) {
  return (
    <LiveProvider initial={initial}>
      <TopBar />
      <main>
        <div className="px-4 pt-4">
          <h1 className="text-[22px] font-semibold">Upstream Event Simulator — stands in for a Synapse-style event feed (demo only)</h1>
        </div>
        {enabled ? (
          <SimulatorInner />
        ) : (
          <div className="p-4" data-testid="simulator-disabled">
            <Panel title="Simulator disabled">
              <p className="p-4 text-[14px] text-muted">The upstream event simulator is off on this server. Set SIMULATOR_ENABLED=1 (or run with DEMO_MODE on) to enable it. Partner integrations post to POST /api/v1/events directly.</p>
            </Panel>
          </div>
        )}
      </main>
    </LiveProvider>
  );
}
