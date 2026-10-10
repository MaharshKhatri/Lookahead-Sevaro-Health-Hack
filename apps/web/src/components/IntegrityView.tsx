'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ViewDTO } from '@/lib/dto';
import { etHms } from '@/lib/format';
import type { IntegrityReport, SliderSample } from '@/server/integrity';
import { LiveProvider, useLive } from './live';
import { TopBar } from './TopBar';
import { Chip, Panel, cx } from './ui';

/**
 * /integrity (brief "What Teams Must Demonstrate" #1: "Rebuild current state
 * from the event stream, handling late and duplicate events, and match the
 * reference snapshot"). Lookahead's event-time replay vs a naive arrival-order
 * replay, the late-event corrections, and the 18:10-18:20 late-video story.
 */

const CONSULT_COLS = ['physician_id', 'current_stage', 'stage_entered_at', 'minutes_in_stage', 'minutes_since_received'] as const;

function Stat({ tone, label, big, sub, testId }: { readonly tone: 'ok' | 'critical'; readonly label: string; readonly big: string; readonly sub: string; readonly testId: string }) {
  return (
    <div data-testid={testId} className={cx('flex-1 rounded-xl border p-5', tone === 'ok' ? 'border-ok/60 bg-ok/8' : 'border-critical/60 bg-critical/8')}>
      <div className="text-[13px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={cx('num mt-1 text-[44px] font-semibold leading-tight', tone === 'ok' ? 'text-ok' : 'text-critical')}>{big}</div>
      <div className="mt-1 text-[14px] text-muted">{sub}</div>
    </div>
  );
}

function stateTone(s: string): string {
  if (s.startsWith('Camera Active')) return 'bg-critical/70 text-text';
  if (s.startsWith('Video')) return 'bg-ok/60 text-bg';
  if (s.includes('Call')) return 'bg-warning/60 text-bg';
  return 'bg-raised text-muted';
}

function Lane({ label, samples, pick, idx }: { readonly label: string; readonly samples: readonly SliderSample[]; readonly pick: (s: SliderSample) => string; readonly idx: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-[260px] shrink-0 text-[13px] text-muted">{label}</div>
      <div className="flex h-7 flex-1 overflow-hidden rounded">
        {samples.map((s, i) => (
          <div key={s.tMs} title={`${etHms(s.tMs)} ${pick(s)}`} className={cx('flex-1 border-r border-bg/60', stateTone(pick(s)), i === idx && 'outline outline-2 -outline-offset-2 outline-text')} />
        ))}
      </div>
    </div>
  );
}

function Slider({ report }: { readonly report: IntegrityReport }) {
  const { subject, samples } = report.slider;
  const [idx, setIdx] = useState(samples.length - 1);
  const s = samples[Math.min(idx, samples.length - 1)];
  if (subject === null || s === undefined) return <p className="p-4 text-muted">No late event retracted a flag in this data.</p>;
  const ext = (x: { flags: readonly string[] }) => x.flags.includes('EXTERNAL_VIDEO_SUSPECTED');
  const box = (title: string, derived: string, external: boolean, extra: string | null, tone: 'critical' | 'ok' | 'muted') => (
    <div className={cx('flex-1 rounded-lg border p-3', tone === 'critical' ? 'border-critical/60 bg-critical/8' : tone === 'ok' ? 'border-ok/60 bg-ok/8' : 'border-border bg-raised/40')}>
      <div className="text-[12px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      <div className="mt-1 text-[17px] font-semibold">{derived}</div>
      <div className="mt-1">{external ? <Chip tone="critical">FLAG: EXTERNAL VIDEO</Chip> : <Chip tone="ok">NO FLAG</Chip>}</div>
      {extra !== null && <div className="mt-1 text-[13px] text-muted">{extra}</div>}
    </div>
  );
  const consultLine = (x: SliderSample['naive']) => (subject.consultId === null || x.consultStage === null ? null : `${subject.consultId}: ${x.consultStage}${x.consultEnteredMs === null ? '' : ` since ${etHms(x.consultEnteredMs)}`}`);
  return (
    <div className="space-y-4 p-4" data-testid="integrity-slider">
      <p className="text-[14px] text-muted">
        {subject.eventId} (video start for {subject.consultId ?? 'a consult'} by {subject.physicianId}) happened at an earlier event time but was ingested at{' '}
        <span className="num text-text">{etHms(subject.windowEndMs)}</span>. Until then every live system saw a camera with no Synapse session and flagged {subject.physicianId}. Lookahead re-applies it at its event time; arrival order never does.
      </p>
      <div className="flex items-center gap-4">
        <span className="num text-[28px] font-semibold text-text">{etHms(s.tMs)}</span>
        <input type="range" min={0} max={samples.length - 1} value={idx} onChange={(e) => setIdx(Number(e.target.value))} className="flex-1 accent-[#2BB3A3]" aria-label="time" data-testid="slider-input" />
      </div>
      <div className="space-y-1.5">
        <Lane label="Naive (arrival order), believed at t" samples={samples} pick={(x) => x.naive.derivedState} idx={idx} />
        <Lane label="Lookahead (event time), known at t" samples={samples} pick={(x) => x.live.derivedState} idx={idx} />
        <Lane label="What happened (known by the reference time)" samples={samples} pick={(x) => x.hindsight.derivedState} idx={idx} />
      </div>
      <div className="flex gap-3">
        {box('Naive, at t', s.naive.derivedState, ext(s.naive), consultLine(s.naive), ext(s.naive) ? 'critical' : 'muted')}
        {box('Lookahead, at t', s.live.derivedState, ext(s.live), consultLine(s.live), ext(s.live) ? 'critical' : 'muted')}
        {box('What happened', s.hindsight.derivedState, s.hindsight.externalVideo, s.hindsight.correctedBy === null ? null : `flag was false: corrected by ${s.hindsight.correctedBy} at ${etHms(subject.windowEndMs)}`, s.hindsight.correctedBy === null ? 'muted' : 'ok')}
      </div>
    </div>
  );
}

function Body() {
  const { view } = useLive();
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [mode, setMode] = useState<'correct' | 'naive'>('naive');
  const version = view?.integrity.eventCount;
  useEffect(() => {
    let alive = true;
    void fetch('/api/integrity', { cache: 'no-store' })
      .then((r) => r.json() as Promise<IntegrityReport>)
      .then((r) => {
        if (alive) setReport(r);
      });
    return () => {
      alive = false;
    };
  }, [version]);
  const rows = useMemo(() => (report === null ? [] : mode === 'correct' ? report.correct.consults : report.naive.consults), [report, mode]);
  if (report === null) return <p className="p-8 text-muted">Loading integrity report…</p>;
  const sum = report.summary;
  const diffs = mode === 'correct' ? report.correct.diffs : report.naive.diffs;
  const bad = new Set(diffs.map((d) => `${d.key}|${d.column}`));
  const ref = new Map((report.reference?.consults ?? []).map((r) => [r.consult_id, r]));
  return (
    <main className="scroll-thin flex-1 space-y-3 overflow-y-auto p-3">
      <div className="flex gap-3">
        <Stat
          testId="integrity-correct"
          tone="ok"
          label="Lookahead: event-time replay vs reference snapshot"
          big={`${sum.physicians.split(' ')[0]} · ${sum.consults.split(' ')[0]} · ${sum.diffs} diffs`}
          sub={`physicians ${sum.physicians}; consults ${sum.consults}; ${sum.duplicates} duplicate${sum.duplicates === 1 ? '' : 's'} dropped, ${sum.lateEvents} late event${sum.lateEvents === 1 ? '' : 's'} re-applied at event time (${sum.eventCount} events${sum.appendedCount > 0 ? `, ${sum.appendedCount} injected` : ''})`}
        />
        <Stat testId="integrity-naive" tone="critical" label="Naive arrival order" big={`${sum.naive.diffs} diffs`} sub={`physicians ${sum.naive.physicians}; consults ${sum.naive.consults}: applied at ingested_at, no dedupe`} />
      </div>

      <Panel
        title="Reference snapshot: open consults"
        right={
          <div className="flex overflow-hidden rounded-md border border-border">
            {(['naive', 'correct'] as const).map((m) => (
              <button key={m} type="button" data-testid={`integrity-mode-${m}`} onClick={() => setMode(m)} className={cx('px-3 py-1 text-[13px] font-semibold', mode === m ? (m === 'naive' ? 'bg-critical text-bg' : 'bg-ok text-bg') : 'bg-raised text-muted')}>
                {m === 'naive' ? `Naive · ${report.naive.diffs.length} mismatched` : `Lookahead · ${report.correct.diffs.length} mismatched`}
              </button>
            ))}
          </div>
        }
      >
        <div className="scroll-thin overflow-x-auto p-2">
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="px-2 py-1 text-left">consult_id</th>
                {CONSULT_COLS.map((c) => (
                  <th key={c} className="px-2 py-1 text-left">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.consult_id}>
                  <td className="num px-2 py-0.5 font-semibold">{r.consult_id}</td>
                  {CONSULT_COLS.map((c) => {
                    const off = bad.has(`${r.consult_id}|${c}`);
                    return (
                      <td key={c} data-mismatch={off} title={off ? `reference: ${ref.get(r.consult_id)?.[c] ?? ''}` : undefined} className={cx('num px-2 py-0.5', off ? 'bg-critical/25 font-semibold text-critical' : 'text-text/85')}>
                        {r[c]}
                        {off && <span className="ml-1.5 text-[11px] text-muted line-through">{ref.get(r.consult_id)?.[c]}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Late-event corrections (knowledge time)">
          <table className="w-full text-[13px]" data-testid="corrections">
            <thead className="text-[11px] uppercase tracking-wider text-muted">
              <tr>
                {['event', 'entity', 'field', 'believed', 'actually', 'wrong from → corrected at'].map((h) => (
                  <th key={h} className="px-3 py-1.5 text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.corrections.map((c) => (
                <tr key={`${c.eventId}|${c.entity.id}|${c.field}`} className="border-t border-border/60">
                  <td className="num whitespace-nowrap px-3 py-1.5">{c.eventId}</td>
                  <td className="num whitespace-nowrap px-3 py-1.5">{c.entity.id}</td>
                  <td className="num px-3 py-1.5 text-muted">{c.field}</td>
                  <td className="px-3 py-1.5 text-critical">{fmt(c.before, c.field)}</td>
                  <td className="px-3 py-1.5 text-ok">{fmt(c.after, c.field)}</td>
                  <td className="num px-3 py-1.5 text-muted">
                    {etHms(c.windowStartMs)} → {etHms(c.windowEndMs)} ({Math.round(c.windowMs / 6000) / 10} min)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Duplicates and late arrivals">
          <div className="space-y-2 p-3 text-[13px]">
            {report.duplicates.map((d) => (
              <div key={d.dropped.line}>
                <Chip tone="warning">DUPLICATE</Chip> <span className="num">{d.kept.eventId}</span>: kept line <span className="num">{d.kept.line}</span>, dropped line <span className="num">{d.dropped.line}</span> — {d.reason}
              </div>
            ))}
            <div className="text-muted">
              {report.lateEvents.length} event{report.lateEvents.length === 1 ? '' : 's'} arrived more than a minute late (OQ-12):{' '}
              {report.lateEvents.map((l) => (
                <span key={l.eventId} className="num mr-2 inline-block text-text" title={`${l.eventType}: event ${etHms(l.eventTimeMs)}, ingested ${etHms(l.ingestedAtMs)}`}>
                  {l.eventId} (+{Math.round(l.lagMs / 1000)} s)
                </span>
              ))}
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="18:10 → 18:20: the late video start">
        <Slider report={report} />
      </Panel>
    </main>
  );
}

function fmt(v: unknown, field: string): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && field.endsWith('Ms')) return etHms(v);
  return String(v);
}

export function IntegrityView({ initial }: { readonly initial: ViewDTO | null }) {
  return (
    <LiveProvider initial={initial}>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <Body />
      </div>
    </LiveProvider>
  );
}
