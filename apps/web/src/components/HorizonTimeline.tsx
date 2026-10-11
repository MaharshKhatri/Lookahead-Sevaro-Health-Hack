'use client';

import type { TimelineItem } from '@lookahead/engine';
import type { ViewDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';

/**
 * HORIZON TIMELINE (Phase 6, D-95): one time axis for the next 180 min with
 * shift ends, confirmed and expected arrivals, surge bands (P(spike) >= 0.5),
 * gap bands (P(gap) >= 0.5), offer and standby expiries and action deadlines.
 * Hand-written SVG on the design tokens; every label is engine text.
 */

const W = 760;
const LEFT = 150;
const ROW = 22;

export function HorizonTimeline({ view }: { readonly view: ViewDTO }) {
  const t = view.intel?.timeline;
  if (t === undefined) return <p className="p-4 text-muted">Timeline unavailable.</p>;
  const names = new Map(view.coverage.rows.map((r) => [r.hospitalId, r.hospitalName]));
  const span = t.toMs - t.fromMs;
  const x = (ms: number) => LEFT + Math.max(0, Math.min(1, (ms - t.fromMs) / span)) * (W - LEFT - 10);
  const hospitals = [...new Set(t.items.filter((i) => i.kind === 'surge_band' || i.kind === 'gap_band').map((i) => i.hospitalId ?? ''))].filter(Boolean);
  const lanes: { label: string; items: TimelineItem[] }[] = [
    { label: 'shift ends', items: t.items.filter((i) => i.kind === 'shift_end') },
    { label: 'arrivals', items: t.items.filter((i) => i.kind === 'arrival_confirmed' || i.kind === 'arrival_expected') },
    ...hospitals.map((h) => ({ label: names.get(h) ?? h, items: t.items.filter((i) => i.hospitalId === h && (i.kind === 'surge_band' || i.kind === 'gap_band')) })),
    { label: 'expiries', items: t.items.filter((i) => i.kind === 'offer_expiry' || i.kind === 'standby_expiry') },
    { label: 'act by', items: t.items.filter((i) => i.kind === 'action_deadline') },
  ];
  const H = 30 + lanes.length * ROW + 10;
  const ticks = Array.from({ length: 7 }, (_, i) => t.fromMs + (i * span) / 6);
  return (
    <div className="p-3" data-testid="horizon-timeline">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-labelledby="tl-title tl-desc">
        <title id="tl-title">Horizon timeline, next 180 minutes</title>
        <desc id="tl-desc">
          {t.items.filter((i) => i.kind !== 'now').map((i) => `${i.label} at ${etHm(i.tMs)}${i.endMs ? ` to ${etHm(i.endMs)}` : ''}`).join('; ')}
        </desc>
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={x(tk)} x2={x(tk)} y1={18} y2={H - 6} stroke="var(--color-border)" strokeWidth={1} />
            <text x={x(tk)} y={12} textAnchor="middle" fontSize={10} fill="var(--color-muted)" className="num">
              {etHm(tk)}
            </text>
          </g>
        ))}
        <line x1={x(t.fromMs)} x2={x(t.fromMs)} y1={18} y2={H - 6} stroke="var(--color-accent)" strokeWidth={2} />
        {lanes.map((lane, li) => {
          const y = 30 + li * ROW;
          return (
            <g key={lane.label}>
              <text x={4} y={y + 13} fontSize={11} fill="var(--color-muted)">
                {lane.label.length > 22 ? `${lane.label.slice(0, 21)}…` : lane.label}
              </text>
              {lane.items.map((it) => {
                const key = `${it.kind}|${it.tMs}|${it.hospitalId ?? ''}|${it.physicianId ?? ''}`;
                const title = `${it.label}: ${it.detail}`;
                if (it.endMs !== null) {
                  const gap = it.kind === 'gap_band';
                  return (
                    <rect key={key} x={x(it.tMs)} y={y + 4} width={Math.max(2, x(it.endMs) - x(it.tMs))} height={ROW - 8} rx={3} fill={gap ? 'var(--color-critical)' : 'var(--color-warning)'} fillOpacity={0.25 + 0.5 * (it.value ?? 0.5)} stroke={gap ? 'var(--color-critical)' : 'var(--color-warning)'} strokeWidth={1}>
                      <title>{title}</title>
                    </rect>
                  );
                }
                const color = it.kind === 'shift_end' ? 'var(--color-critical)' : it.kind === 'arrival_confirmed' ? 'var(--color-ok)' : it.kind === 'arrival_expected' ? 'var(--color-warning)' : it.kind === 'action_deadline' ? 'var(--color-accent)' : 'var(--color-info)';
                const px = Math.max(LEFT, x(it.tMs));
                return (
                  <g key={key}>
                    {it.kind === 'action_deadline' ? <path d={`M ${px} ${y + 4} L ${px + 6} ${y + ROW / 2} L ${px} ${y + ROW - 4} L ${px - 6} ${y + ROW / 2} Z`} fill={color} /> : <circle cx={px} cy={y + ROW / 2} r={5} fill={color} />}
                    <title>{title}</title>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px] text-muted">
        {t.items
          .filter((i) => i.kind !== 'now')
          .map((i) => (
            <li key={`${i.kind}|${i.tMs}|${i.hospitalId ?? ''}|${i.physicianId ?? ''}`} className="truncate" title={i.detail}>
              <span className="num text-text">{etHm(i.tMs)}</span>
              {i.endMs !== null && <span className="num">–{etHm(i.endMs)}</span>} {i.label}
            </li>
          ))}
      </ul>
    </div>
  );
}
