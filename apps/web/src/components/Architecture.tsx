'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewDTO } from '@/lib/dto';
import type { ArchitectureDTO, CounterDTO } from '@/server/architecture';
import type { ScaleTestResult, StageComparison } from '@/server/scaleTest';
import type { Testimonial as TestimonialValue } from '@/server/testimonial';
import { etHms } from '@/lib/format';
import { LiveProvider, useStoreVersion } from './live';
import { Testimonial } from './Testimonial';
import { TopBar } from './TopBar';
import { Button, Chip, Panel, cx } from './ui';

/**
 * /architecture (sprint A4/B3): "AI narrates. Humans decide." The hero copy
 * states the boundary; the counters and badges below are computed by the
 * server from the action log and the repository at request time and refresh
 * on every /api/stream version change (changed values flash). The diagram is
 * hand-written SVG; the Mermaid source is shown verbatim.
 */

// ------------------------------------------------------------------ diagram

const STAGES: readonly { readonly key: string; readonly title: string; readonly sub: string; readonly human?: string }[] = [
  { key: 'ingest', title: 'ingest', sub: 'CSV, /api/v1/events' },
  { key: 'replay', title: 'replay', sub: 'event-time state' },
  { key: 'detect', title: 'detect', sub: 'routing, coverage' },
  { key: 'forecast', title: 'forecast', sub: 'surge model' },
  { key: 'decide', title: 'decide / standby', sub: 'ledger, trap', human: 'coordinator proposes' },
  { key: 'approval', title: 'approval', sub: 'PHI re-check', human: 'clinical lead approves' },
  { key: 'act', title: 'act', sub: 'append-only log', human: 'physician accepts' },
  { key: 'audit', title: 'audit', sub: 'trail, CSV, S3' },
];

function Diagram() {
  const W = 980;
  const H = 330;
  const bw = 104;
  const gap = (W - 20 - STAGES.length * bw) / (STAGES.length - 1);
  const x = (i: number) => 10 + i * (bw + gap);
  const y = 70;
  const bh = 58;
  const iDecide = STAGES.findIndex((s) => s.key === 'decide');
  const gx = x(2);
  const gy = 230;
  const bx = x(5);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[720px] w-full" role="img" aria-labelledby="arch-title arch-desc">
        <title id="arch-title">Lookahead decision pipeline</title>
        <desc id="arch-desc">
          ingest, replay, detect, forecast, decide and standby, approval, act, audit, in that order. People act at decide (coordinator), approval (clinical lead) and act (physician). Amazon Bedrock is a separate narrator sidecar that receives engine facts through the fidelity guard and returns text to the screen only; it has no path into approval, act or the action log.
        </desc>
        <defs>
          <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--color-muted)" />
          </marker>
          <marker id="arch-arrow-ai" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--color-info)" />
          </marker>
        </defs>
        <text x={10} y={22} fontSize={12} fill="var(--color-muted)" fontWeight={600} letterSpacing="0.12em">
          DETERMINISTIC ENGINE, TESTED (DECISION PATH)
        </text>
        {STAGES.map((s, i) => (
          <g key={s.key}>
            <rect x={x(i)} y={y} width={bw} height={bh} rx={6} fill="var(--color-raised)" stroke={s.human === undefined ? 'var(--color-border)' : 'var(--color-accent)'} strokeWidth={s.human === undefined ? 1 : 1.5} />
            <text x={x(i) + bw / 2} y={y + 25} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--color-text)">
              {s.title}
            </text>
            <text x={x(i) + bw / 2} y={y + 43} textAnchor="middle" fontSize={10.5} fill="var(--color-muted)">
              {s.sub}
            </text>
            {s.human !== undefined && (
              <g>
                <line x1={x(i) + bw / 2} y1={y - 22} x2={x(i) + bw / 2} y2={y - 2} stroke="var(--color-accent)" markerEnd="url(#arch-arrow)" />
                <text x={x(i) + bw / 2} y={y - 28} textAnchor="middle" fontSize={10.5} fill="var(--color-accent)" fontWeight={600}>
                  {s.human}
                </text>
              </g>
            )}
            {i < STAGES.length - 1 && <line x1={x(i) + bw + 2} y1={y + bh / 2} x2={x(i + 1) - 3} y2={y + bh / 2} stroke="var(--color-muted)" strokeWidth={1.4} markerEnd="url(#arch-arrow)" />}
          </g>
        ))}
        {/* Boundary between the decision path and the narrator sidecar. */}
        <line x1={10} y1={175} x2={W - 10} y2={175} stroke="var(--color-border)" strokeDasharray="6 4" />
        <text x={10} y={196} fontSize={12} fill="var(--color-info)" fontWeight={600} letterSpacing="0.12em">
          NARRATOR SIDECAR (TEXT ONLY, NO WRITE PATH)
        </text>
        <text x={W - 10} y={196} textAnchor="end" fontSize={10.5} fill="var(--color-muted)">
          no arrow from the sidecar reaches approval, act or the action log
        </text>
        {/* facts flow down from decide into the guard */}
        <path d={`M ${x(iDecide) + bw / 2} ${y + bh + 2} L ${x(iDecide) + bw / 2} ${gy - 30} L ${gx + 150} ${gy - 30} L ${gx + 150} ${gy - 2}`} fill="none" stroke="var(--color-info)" strokeDasharray="4 3" markerEnd="url(#arch-arrow-ai)" />
        <text x={x(iDecide) + bw / 2 + 6} y={gy - 36} fontSize={10.5} fill="var(--color-info)">
          engine facts (JSON)
        </text>
        <rect x={gx} y={gy} width={300} height={56} rx={6} fill="var(--color-panel)" stroke="var(--color-info)" />
        <text x={gx + 150} y={gy + 23} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--color-text)">
          fidelity guard
        </text>
        <text x={gx + 150} y={gy + 41} textAnchor="middle" fontSize={10.5} fill="var(--color-muted)">
          numbers, times, names must match facts; PHI denylist; length
        </text>
        <rect x={bx} y={gy} width={220} height={56} rx={6} fill="var(--color-panel)" stroke="var(--color-info)" strokeDasharray="5 3" />
        <text x={bx + 110} y={gy + 23} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--color-text)">
          Amazon Bedrock narrator
        </text>
        <text x={bx + 110} y={gy + 41} textAnchor="middle" fontSize={10.5} fill="var(--color-muted)">
          optional; template served on any failure
        </text>
        <line x1={gx + 302} y1={gy + 18} x2={bx - 3} y2={gy + 18} stroke="var(--color-info)" strokeDasharray="4 3" markerEnd="url(#arch-arrow-ai)" />
        <line x1={bx - 2} y1={gy + 38} x2={gx + 304} y2={gy + 38} stroke="var(--color-info)" strokeDasharray="4 3" markerEnd="url(#arch-arrow-ai)" />
        <path d={`M ${gx} ${gy + 28} L ${x(0) + 40} ${gy + 28} L ${x(0) + 40} ${gy + 76}`} fill="none" stroke="var(--color-info)" strokeDasharray="4 3" markerEnd="url(#arch-arrow-ai)" />
        <text x={x(0) + 48} y={gy + 74} fontSize={10.5} fill="var(--color-info)">
          sentences on screen for people to read
        </text>
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ counters

function CounterTile({ c, flash }: { readonly c: CounterDTO; readonly flash: boolean }) {
  const bad = c.expected === 'zero' && c.value !== null && c.value > 0;
  return (
    <div
      data-testid={`counter-${c.name}`}
      data-value={c.value === null ? 'null' : String(c.value)}
      className={cx('rounded-md border bg-raised p-3 transition-shadow duration-700', bad ? 'border-critical' : 'border-border', flash && 'ring-2 ring-accent')}
    >
      <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">{c.label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cx('num text-[30px] font-semibold leading-none', bad ? 'text-critical' : c.value === null ? 'text-muted' : 'text-text')}>{c.value === null ? 'not logged' : c.value}</span>
        {c.expected === 'zero' && c.value !== null && <Chip tone={bad ? 'critical' : 'ok'}>{bad ? 'violation' : 'expected 0'}</Chip>}
      </div>
      <p className="mt-2 text-[12.5px] leading-snug text-muted">{c.definition}</p>
      {c.breakdown.length > 0 && (
        <p className="num mt-1 text-[12px] text-muted">
          {c.breakdown.map((b) => `${b.key} ${b.count}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

function Badges({ d }: { readonly d: ArchitectureDTO }) {
  const h = d.badges.hardcode;
  const t = d.badges.tests;
  return (
    <div className="flex flex-wrap gap-3">
      <div data-testid="badge-hardcode" data-status={h.status} className="rounded-md border border-border bg-raised px-3 py-2 text-[13.5px]">
        <Chip tone={h.status === 'clean' ? 'ok' : h.status === 'hits' ? 'critical' : 'muted'}>{h.status === 'clean' ? 'pass' : h.status === 'hits' ? 'fail' : 'n/a'}</Chip>{' '}
        {h.status === 'unavailable' ? (
          <span className="text-muted">Hard-coded ID scan unavailable: {h.dir} is not present at runtime.</span>
        ) : h.status === 'clean' ? (
          <span>
            Zero hard-coded IDs in engine source: <span className="num">{h.filesScanned}</span> files in {h.dir} scanned now for /\b(PHY|CON|SYN|EVT)-\d+/.
          </span>
        ) : (
          <span className="text-critical">
            <span className="num">{h.hits.length}</span> hard-coded ID literal(s) in {h.dir}: {h.hits.slice(0, 5).join(', ')}
          </span>
        )}
      </div>
      <div data-testid="badge-tests" data-status={t.status} className="rounded-md border border-border bg-raised px-3 py-2 text-[13.5px]">
        {t.status === 'none' ? (
          <span className="text-muted">No test report yet (docs/test-report.json is written by pnpm test:report).</span>
        ) : (
          <span>
            <Chip tone={t.status === 'pass' ? 'ok' : 'critical'}>{t.status}</Chip> <span className="num">{t.passed}</span> of <span className="num">{t.tests}</span> tests passed
            {t.failed !== null && t.failed > 0 ? (
              <>
                , <span className="num text-critical">{t.failed}</span> failed
              </>
            ) : null}{' '}
            in <span className="num">{t.files}</span> files, last run {t.generatedAtMs === null ? 'unknown' : new Date(t.generatedAtMs).toISOString().replace('T', ' ').slice(0, 16)} UTC ({t.command}).
          </span>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ scale test

const fmtMs = (ms: number | null) => (ms === null ? 'n/a' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms >= 100 ? ms.toFixed(0) : ms.toFixed(1)} ms`);

function ScaleChart({ stages, factor }: { readonly stages: readonly StageComparison[]; readonly factor: number }) {
  const rows = stages.filter((s) => s.xNMs !== null);
  const max = Math.max(1, ...rows.map((s) => Math.max(s.xNMs ?? 0, s.x1Ms ?? 0)));
  const W = 760;
  const L = 300;
  const R = 90;
  const rowH = 30;
  const H = rows.length * rowH + 40;
  const sx = (ms: number) => ((W - L - R) * ms) / max;
  const budget = max >= 1000 ? L + sx(1000) : null;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[600px] w-full" role="img" aria-label={`Measured stage timings, x1 and x${factor}`} data-testid="scale-chart">
        <text x={L} y={14} fontSize={11} fill="var(--color-muted)">
          <tspan fill="var(--color-muted)">■ x1 reference</tspan>
          <tspan dx={14} fill="var(--color-accent)">
            ■ x{factor}
          </tspan>
          <tspan dx={14}>linear scale, longest bar {fmtMs(max)}</tspan>
        </text>
        {budget !== null && (
          <g>
            <line x1={budget} y1={20} x2={budget} y2={H - 6} stroke="var(--color-warning)" strokeDasharray="4 3" />
            <text x={budget + 4} y={H - 8} fontSize={10} fill="var(--color-warning)">
              1 s
            </text>
          </g>
        )}
        {rows.map((s, i) => {
          const y0 = 26 + i * rowH;
          return (
            <g key={s.stage} data-testid="scale-row">
              <text x={L - 8} y={y0 + 15} textAnchor="end" fontSize={11.5} fill="var(--color-text)">
                {s.stage.length > 44 ? `${s.stage.slice(0, 43)}…` : s.stage}
              </text>
              <rect x={L} y={y0 + 2} width={Math.max(1, sx(s.x1Ms ?? 0))} height={9} fill="var(--color-muted)" />
              <rect x={L} y={y0 + 13} width={Math.max(1, sx(s.xNMs ?? 0))} height={11} fill={s.underBudget ? 'var(--color-accent)' : 'var(--color-warning)'} />
              <text x={L + Math.max(1, sx(s.xNMs ?? 0)) + 6} y={y0 + 22} fontSize={10.5} fill="var(--color-text)" className="num">
                {fmtMs(s.xNMs)}
              </text>
              <text x={L + Math.max(1, sx(s.x1Ms ?? 0)) + 6} y={y0 + 10} fontSize={9.5} fill="var(--color-muted)" className="num">
                {fmtMs(s.x1Ms)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ScaleTest({ factor }: { readonly factor: number }) {
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<ScaleTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [busy]);
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setStartedAt(performance.now());
    try {
      const r = await fetch('/api/scale-test', { method: 'POST', cache: 'no-store' });
      const b = (await r.json()) as ScaleTestResult | { ok: false; message: string };
      if ('stages' in b || 'code' in b) setResult(b as ScaleTestResult);
      else setError(b.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const elapsed = busy && startedAt !== null ? (performance.now() - startedAt) / 1000 : null;
  return (
    <Panel title="Live scale test" testId="scale-test" right={<Button testId="scale-run" onClick={() => void run()} disabled={busy}>{busy ? 'Running…' : `Run x${factor} scale test`}</Button>}>
      <div className="space-y-3 p-4 text-[14px]">
        <p className="text-muted">
          Clones the Sevaro package {factor} times with remapped ids (scripts/scale-bench.ts) and times each engine stage once, in a separate process, so the live store is never touched. One run at a time; a run that exceeds the time limit is killed and reported with the stage it reached.
        </p>
        {elapsed !== null && (
          <p data-testid="scale-running" className="num text-info" data-tick={tick}>
            running, {elapsed.toFixed(1)} s elapsed
          </p>
        )}
        {error !== null && <p className="text-critical">{error}</p>}
        {result !== null && !result.ok && (
          <p data-testid="scale-error" className="rounded border border-critical/60 bg-critical/10 p-2 text-critical">
            {result.code} ({result.status}): {result.message}
          </p>
        )}
        {result !== null && result.ok && (
          <div data-testid="scale-result" className="space-y-2">
            <p className="text-text">{result.summary}</p>
            <p className="num text-[12.5px] text-muted">
              Measured on {result.bench.machine.cpu} x{result.bench.machine.cores}, Node {result.bench.machine.node}; whole run {fmtMs(result.elapsedMs)} including process start and cloning ({fmtMs(result.bench.cloneMs)}).
            </p>
            <ScaleChart stages={result.stages} factor={result.factor} />
            <ul className="space-y-0.5 text-[13px] text-muted">
              {result.stages.map((s) => (
                <li key={s.stage}>· {s.sentence}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ page

function Body({ initial, mermaid, testimonial, scaleFactor }: { readonly initial: ArchitectureDTO; readonly mermaid: string; readonly testimonial: TestimonialValue | null; readonly scaleFactor: number }) {
  const [d, setD] = useState(initial);
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const prev = useRef(initial);
  const refetch = useCallback(async () => {
    try {
      const r = await fetch('/api/architecture', { cache: 'no-store' });
      if (!r.ok) return;
      const next = (await r.json()) as ArchitectureDTO;
      const changed = new Set(next.counters.filter((c) => prev.current.counters.find((p) => p.name === c.name)?.value !== c.value).map((c) => c.name));
      prev.current = next;
      setD(next);
      if (changed.size > 0) {
        setFlash(changed);
        setTimeout(() => setFlash(new Set()), 1500);
      }
    } catch {
      // keep the last good counters; the next stream message retries
    }
  }, []);
  const sse = useStoreVersion(() => void refetch());
  return (
    <main data-testid="architecture" className="flex-1 space-y-4 overflow-auto p-4">
      <section className="rounded-lg border border-border bg-panel p-5">
        <h1 className="text-[28px] font-semibold leading-tight text-text">AI narrates. Humans decide.</h1>
        <p className="mt-1 max-w-[900px] text-[15px] text-muted">
          Every action must be explainable, auditable and reversible, so every decision comes from the deterministic, tested engine and a named person, never from a language model.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div data-testid="ai-does" className="rounded-md border border-info/50 bg-info/5 p-4">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-info">What AI does</h2>
            <ul className="mt-2 space-y-1.5 text-[14.5px] text-text">
              <li>· Narrates why a hospital is at risk: an attention item&apos;s engine facts become two or three plain sentences.</li>
              <li>· Turns computed numbers (the recommendation, the lead&apos;s briefing) into sentences, using only the facts it is given.</li>
              <li>· Drafts wording for people to read. The fidelity guard rejects any number, time or name not in the facts, and any PHI; on any failure the deterministic template is shown instead.</li>
              <li>· Messages to physicians are drafted by an engine template, PHI-guarded at drafting and again at send, and sent only after the clinical lead approves.</li>
            </ul>
          </div>
          <div data-testid="ai-never" className="rounded-md border border-critical/50 bg-critical/5 p-4">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-critical">What AI never does</h2>
            <ul className="mt-2 space-y-1.5 text-[14.5px] text-text">
              <li>· Choose which physician to call: eligibility and ranking are the engine&apos;s rule-by-rule ledger.</li>
              <li>· Select a standby physician: the standby plan is the engine&apos;s computed value ranking.</li>
              <li>· Send any message without human approval: the clinical lead approves every offer and pre-alert.</li>
              <li>· Change consult or physician state: state is rebuilt only from Sevaro&apos;s event stream; our own actions live in a separate append-only log.</li>
            </ul>
          </div>
        </div>
      </section>

      <Panel title="Decision pipeline" testId="arch-diagram">
        <div className="space-y-3 p-4">
          <Diagram />
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted">Mermaid source (deployment view, same as docs/ARCHITECTURE.md)</summary>
            <pre className="num mt-2 overflow-x-auto rounded border border-border bg-bg p-3 text-[12px] leading-snug text-text">{mermaid}</pre>
          </details>
        </div>
      </Panel>

      <Panel
        title="Live counters from the action log"
        testId="arch-counters"
        right={
          <span className="num text-[12.5px] text-muted">
            {d.logLength} actions · v{d.version} · sim {etHms(d.nowMs)} · stream {sse}
          </span>
        }
      >
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
          {d.counters.map((c) => (
            <CounterTile key={c.name} c={c} flash={flash.has(c.name)} />
          ))}
        </div>
        <div className="border-t border-border p-4">
          <Badges d={d} />
        </div>
      </Panel>

      <ScaleTest factor={scaleFactor} />

      <Testimonial value={testimonial} />
    </main>
  );
}

export function Architecture({
  initialView,
  initial,
  mermaid,
  testimonial,
  scaleFactor,
}: {
  readonly initialView: ViewDTO | null;
  readonly initial: ArchitectureDTO;
  readonly mermaid: string;
  readonly testimonial: TestimonialValue | null;
  readonly scaleFactor: number;
}) {
  return (
    <LiveProvider initial={initialView}>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <Body initial={initial} mermaid={mermaid} testimonial={testimonial} scaleFactor={scaleFactor} />
      </div>
    </LiveProvider>
  );
}
