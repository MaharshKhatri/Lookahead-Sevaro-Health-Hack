'use client';

import { useMemo, useState } from 'react';
import type { RewindReportDTO, ViewDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import { LiveProvider } from './live';
import { TopBar } from './TopBar';
import { Chip, Panel, cx } from './ui';

/**
 * /rewind (Phase 5, D-94): the day as if Lookahead had been running. A slider
 * over the 5-min origins, P(spike) / P(gap) curves for the hospitals that
 * later had routing failures, markers for the rule tripping, the pre-alert,
 * the activation and the online time, the three-line comparison and the
 * assumptions box. Hand-written SVG; every number is engine output.
 */

const W = 820;
const H = 220;
const PAD = { l: 44, r: 12, t: 16, b: 28 };

const MARKER_WORD: Readonly<Record<string, string>> = { rule_tripped: 'RULE TRIPPED', pre_alert: 'PRE-ALERT', activation: 'ACTIVATION', online: 'ONLINE', first_routing_failure: 'FIRST ROUTING FAILURE', deadlock: 'DEADLOCK' };
const MARKER_COLOR: Readonly<Record<string, string>> = { rule_tripped: 'var(--color-warning)', pre_alert: 'var(--color-info)', activation: 'var(--color-accent)', online: 'var(--color-ok)', first_routing_failure: 'var(--color-critical)', deadlock: 'var(--color-critical)' };
const LINE_COLORS = ['var(--color-critical)', 'var(--color-warning)', 'var(--color-info)', 'var(--color-accent)', 'var(--color-ok)'];

function Chart({ r, idx }: { readonly r: RewindReportDTO; readonly idx: number }) {
  const hospitals = useMemo(() => {
    const set = new Set<string>();
    for (const o of r.origins) for (const [h, v] of Object.entries(o.pGapByHospital)) if (v >= 0.5) set.add(h);
    for (const m of r.markers) if (m.hospitalId) set.add(m.hospitalId);
    return [...set].sort();
  }, [r]);
  const span = Math.max(1, r.toMs - r.fromMs);
  const x = (ms: number) => PAD.l + ((ms - r.fromMs) / span) * (W - PAD.l - PAD.r);
  const y = (p: number) => PAD.t + (1 - p) * (H - PAD.t - PAD.b);
  const path = (key: 'pSpikeByHospital' | 'pGapByHospital', h: string) => r.origins.map((o, i) => `${i === 0 ? 'M' : 'L'} ${x(o.tMs).toFixed(1)} ${y(o[key][h] ?? 0).toFixed(1)}`).join(' ');
  const cur = r.origins[idx];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-labelledby="rw-title rw-desc" data-testid="rewind-chart">
      <title id="rw-title">P(spike) and P(gap) by origin</title>
      <desc id="rw-desc">{hospitals.map((h) => `${r.hospitalNames?.[h] ?? h}: P(gap) at the last origin ${r.origins.at(-1)?.pGapByHospital[h] ?? 0}`).join('; ')}</desc>
      {[0, 0.5, 1].map((p) => (
        <g key={p}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(p)} y2={y(p)} stroke="var(--color-border)" />
          <text x={PAD.l - 6} y={y(p) + 4} textAnchor="end" fontSize={10} fill="var(--color-muted)" className="num">
            {p}
          </text>
        </g>
      ))}
      {r.origins.filter((_, i) => i % 6 === 0).map((o) => (
        <text key={o.tMs} x={x(o.tMs)} y={H - 10} textAnchor="middle" fontSize={10} fill="var(--color-muted)" className="num">
          {etHm(o.tMs)}
        </text>
      ))}
      {hospitals.map((h, i) => (
        <g key={h}>
          <path d={path('pGapByHospital', h)} fill="none" stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2}>
            <title>{`${r.hospitalNames?.[h] ?? h}: P(gap)`}</title>
          </path>
          <path d={path('pSpikeByHospital', h)} fill="none" stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={1.5} strokeDasharray="4 3">
            <title>{`${r.hospitalNames?.[h] ?? h}: P(spike at +60)`}</title>
          </path>
        </g>
      ))}
      {r.markers.map((m) => (
        <g key={`${m.kind}|${m.tMs}`}>
          <line x1={x(m.tMs)} x2={x(m.tMs)} y1={PAD.t} y2={H - PAD.b} stroke={MARKER_COLOR[m.kind] ?? 'var(--color-muted)'} strokeWidth={1.5} strokeDasharray={m.kind === 'online' ? undefined : '2 2'} />
          <title>{m.detail}</title>
        </g>
      ))}
      {cur !== undefined && <line x1={x(cur.tMs)} x2={x(cur.tMs)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-text)" strokeWidth={2} />}
      <g>
        {hospitals.map((h, i) => (
          <text key={h} x={PAD.l + 4 + i * 160} y={PAD.t - 4} fontSize={10} fill={LINE_COLORS[i % LINE_COLORS.length]}>
            ■ {r.hospitalNames?.[h] ?? h} (solid P(gap), dashed P(spike))
          </text>
        ))}
      </g>
    </svg>
  );
}

function Body({ report }: { readonly report: RewindReportDTO | null }) {
  const [idx, setIdx] = useState(report === null ? 0 : report.origins.length - 1);
  if (report === null) {
    return (
      <main className="p-6" data-testid="rewind-not-ready">
        <Panel title="Rewind">
          <p className="p-4 text-muted">The counterfactual replay is not available yet (the engine export is missing). Nothing is shown rather than a guess.</p>
        </Panel>
      </main>
    );
  }
  const o = report.origins[Math.min(idx, report.origins.length - 1)];
  const [actual, reactive, anticipatory] = report.lines;
  const names = report.hospitalNames ?? {};
  return (
    <main className="scroll-thin flex-1 space-y-3 overflow-y-auto p-3" data-testid="rewind">
      <Panel title={<>REWIND <span className="normal-case tracking-normal text-text">— the day as if Lookahead had been running</span></>} right={<span className="num text-[12px] text-muted">{report.origins.length} origins · {etHm(report.fromMs)}–{etHm(report.toMs)} ET · step {report.stepMin} min</span>}>
        <div className="p-3">
          <Chart r={report} idx={idx} />
          <div className="mt-2 flex items-center gap-3">
            <input type="range" min={0} max={report.origins.length - 1} value={idx} onChange={(e) => setIdx(Number(e.target.value))} className="flex-1 accent-[var(--color-accent)]" aria-label="origin" data-testid="rewind-slider" />
            <span className="num w-[60px] text-right text-[16px] font-semibold" data-testid="rewind-origin">
              {o === undefined ? '—' : etHm(o.tMs)}
            </span>
          </div>
          {o !== undefined && (
            <div className="mt-2 grid grid-cols-3 gap-3 text-[13px]" data-testid="rewind-origin-detail">
              <div>
                <div className="text-muted">rule tripped</div>
                <div className="font-semibold">{o.ruleTripped ? 'yes' : 'no'}</div>
              </div>
              <div>
                <div className="text-muted">deadlocks</div>
                <div className="font-semibold">{o.deadlocks.map((h) => names[h] ?? h).join(', ') || 'none'}</div>
              </div>
              <div>
                <div className="text-muted">pre-alert recommended</div>
                <div className="font-semibold">{o.recommendedPreAlert.join(', ') || 'nobody'}{o.activationRecommended ? ' · activation recommended' : ''}</div>
              </div>
              <div className="col-span-3 flex flex-wrap gap-2">
                {Object.entries(o.pGapByHospital)
                  .filter(([, v]) => v > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([h, v]) => (
                    <Chip key={h} tone={v >= 0.5 ? 'critical' : 'muted'}>
                      {names[h] ?? h} P(gap) {v}
                    </Chip>
                  ))}
              </div>
            </div>
          )}
        </div>
      </Panel>
      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-3">
        <Panel title="Three lines — stroke consult-minutes unassigned" testId="rewind-lines">
          <table className="w-full text-left text-[14px]">
            <thead className="text-[12px] uppercase tracking-wider text-muted">
              <tr>
                <th className="px-3 py-2">line</th>
                <th className="px-3 py-2">online at</th>
                <th className="px-3 py-2">physician</th>
                <th className="px-3 py-2 text-right">total minutes</th>
              </tr>
            </thead>
            <tbody>
              {report.lines.map((l) => (
                <tr key={l.kind} className="border-t border-border" data-testid={`rewind-line-${l.kind}`}>
                  <td className="px-3 py-2">
                    <div className="font-semibold capitalize">{l.kind}</div>
                    <div className="text-[12px] text-muted">{l.label}</div>
                  </td>
                  <td className="num px-3 py-2">{'onlineAtMs' in l && typeof (l as { onlineAtMs?: number | null }).onlineAtMs === 'number' ? etHm((l as { onlineAtMs: number }).onlineAtMs) : '—'}</td>
                  <td className="num px-3 py-2">{(l as { physicianId?: string | null }).physicianId ?? '—'}</td>
                  <td className="num px-3 py-2 text-right text-[18px] font-semibold" data-testid={`rewind-total-${l.kind}`}>
                    {l.totalStrokeMinutesUnassigned}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {actual && reactive && anticipatory && (
            <div className="border-t border-border p-3 text-[13px]">
              <div className="mb-1 font-semibold">Consults whose outcome differs</div>
              <ul className="space-y-0.5">
                {actual.perConsult.map((row, i) => {
                  const b = reactive.perConsult[i];
                  const c = anticipatory.perConsult[i];
                  if (!b || !c || (row.minutesUnassigned === b.minutesUnassigned && row.minutesUnassigned === c.minutesUnassigned)) return null;
                  return (
                    <li key={row.consultId} className="num">
                      {row.consultId} ({names[row.hospitalId] ?? row.hospitalId}, received {etHm(row.receivedMs)}): actual {row.minutesUnassigned} · reactive {b.minutesUnassigned} · anticipatory {c.minutesUnassigned} min
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="border-t border-border p-3 text-[13px] text-muted">
            <ul className="space-y-1">
              {report.explanation.map((e) => (
                <li key={e}>· {e}</li>
              ))}
            </ul>
          </div>
        </Panel>
        <div className="space-y-3">
          <Panel title="Markers" testId="rewind-markers">
            <ul className="space-y-1.5 p-3 text-[13px]">
              {report.markers.map((m) => (
                <li key={`${m.kind}|${m.tMs}`} className="flex gap-2">
                  <span className="num w-[44px] shrink-0 text-text">{etHm(m.tMs)}</span>
                  <span className={cx('shrink-0 rounded border px-1 text-[10px] font-semibold uppercase')} style={{ color: MARKER_COLOR[m.kind], borderColor: MARKER_COLOR[m.kind] }}>
                    {MARKER_WORD[m.kind] ?? m.kind}
                  </span>
                  <span className="text-muted">{m.detail}</span>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Assumptions (LOOKAHEAD-DEFINED, illustrative)" testId="rewind-assumptions">
            <div className="p-3 text-[13px]">
              <table className="w-full text-left">
                <tbody>
                  <tr><td className="text-muted">lead approval</td><td className="num text-right">{report.assumptions.leadApprovalMin} min</td></tr>
                  <tr><td className="text-muted">acknowledgment</td><td className="num text-right">{report.assumptions.ackMin} min</td></tr>
                  <tr><td className="text-muted">activation approval</td><td className="num text-right">{report.assumptions.activationApprovalMin} min</td></tr>
                  <tr><td className="text-muted">accept</td><td className="num text-right">{report.assumptions.acceptMin} min</td></tr>
                </tbody>
              </table>
              <p className="mt-2 text-muted">{report.assumptions.note}</p>
            </div>
          </Panel>
        </div>
      </div>
    </main>
  );
}

export function RewindView({ initial, report }: { readonly initial: ViewDTO | null; readonly report: RewindReportDTO | null }) {
  return (
    <LiveProvider initial={initial}>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <Body report={report} />
      </div>
    </LiveProvider>
  );
}
