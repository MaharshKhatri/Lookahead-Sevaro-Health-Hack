'use client';

import { useEffect, useRef, useState } from 'react';
import type { TimelineItem } from '@lookahead/engine';
import { etHm } from '@/lib/format';

/**
 * The Horizon Line (UI pass signature element): one full-width time axis from
 * now - 30 to now + 180 min. The past is faint; "now" is a fixed vertical
 * edge at 14 % from the left; the future axis is the only teal line on
 * screen. Every marker is an engine TimelineItem (incidents/buildTimeline,
 * D-95) drawn with its own shape: shift ends (bracket, "-N physicians"),
 * confirmed/expected arrivals (solid/dashed bracket, "+N"), surge windows
 * (hatched band, opacity = P(spike)), projected gaps (red segment under the
 * line), offer/standby expiries (hourglass), action deadlines (teal flag).
 * Labels sit on two lanes above and two below, placed greedily so they
 * never overlap; a label that cannot be placed is dropped from the canvas
 * but stays in the text summary and the marker's tooltip.
 */

export const PAST_MIN = 30;
export const FUTURE_MIN = 180;
const MIN = 60_000;
const DEFAULT_W = 1200;
const H = 116;
const PAD_L = 8;
const PAD_R = 12;
const AXIS_Y = 64;
const CHAR_W = 6.1;

export interface HorizonMarker {
  readonly key: string;
  readonly kind: TimelineItem['kind'];
  readonly tMs: number;
  readonly endMs: number | null;
  readonly label: string;
  readonly detail: string;
  readonly hospitalIds: readonly string[];
  readonly physicianIds: readonly string[];
  readonly value: number | null;
}

/** Group point events at the same minute (e.g. three shift ends at 19:00 -> one bracket "-3 physicians"). Pure, exported for tests. */
export function toMarkers(items: readonly TimelineItem[]): HorizonMarker[] {
  const out: HorizonMarker[] = [];
  const groups = new Map<string, TimelineItem[]>();
  for (const i of items) {
    if (i.kind === 'now') continue;
    if (i.kind === 'shift_end' || i.kind === 'arrival_confirmed' || i.kind === 'arrival_expected') {
      const k = `${i.kind}|${Math.floor(i.tMs / MIN)}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
      continue;
    }
    out.push({
      key: `${i.kind}|${i.tMs}|${i.hospitalId ?? ''}|${i.physicianId ?? ''}`,
      kind: i.kind,
      tMs: i.tMs,
      endMs: i.endMs,
      label: i.label,
      detail: i.detail,
      hospitalIds: i.hospitalId === null ? [] : [i.hospitalId],
      physicianIds: i.physicianId === null ? [] : [i.physicianId],
      value: i.value,
    });
  }
  for (const [k, g] of groups) {
    const first = g[0];
    if (first === undefined) continue;
    const n = g.length;
    const label = first.kind === 'shift_end' ? `−${n} physician${n === 1 ? '' : 's'}` : `+${n} ${first.kind === 'arrival_confirmed' ? 'confirmed' : 'expected'}`;
    out.push({
      key: k,
      kind: first.kind,
      tMs: first.tMs,
      endMs: null,
      label,
      detail: g.map((i) => `${i.label} (${i.detail})`).join('; '),
      hospitalIds: [...new Set(g.flatMap((i) => (i.hospitalId === null ? [] : [i.hospitalId])))],
      physicianIds: [...new Set(g.flatMap((i) => (i.physicianId === null ? [] : [i.physicianId])))],
      value: null,
    });
  }
  // Plain code-unit order (not localeCompare): server and browser ICU may collate differently, which would break hydration.
  return out.sort((a, b) => a.tMs - b.tMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

interface Placed {
  readonly m: HorizonMarker;
  readonly x: number;
  readonly lane: number | null;
}

/** Greedy lane assignment: lanes -1, -2 above the axis and 1, 2 below; each keeps the right edge of its last label. Pure, exported for tests. */
export function placeLabels(markers: readonly HorizonMarker[], x: (ms: number) => number): Placed[] {
  const lanesFor = (k: HorizonMarker['kind']): number[] => (k === 'shift_end' || k === 'action_deadline' || k === 'surge_band' ? [-1, -2] : [1, 2]);
  const right = new Map<number, number>();
  return markers
    .filter((m) => m.kind !== 'gap_band' && m.kind !== 'surge_band')
    .map((m) => {
      const px = x(m.tMs);
      const w = m.label.length * CHAR_W + 14;
      const lane = lanesFor(m.kind).find((l) => (right.get(l) ?? -Infinity) + 6 <= px) ?? null;
      if (lane !== null) right.set(lane, px + w);
      return { m, x: px, lane };
    });
}

// Lanes sit 18 px apart; the topmost lane (-2) stays clear of the "now" label at the top edge.
const laneY = (lane: number) => (lane < 0 ? AXIS_Y - 18 - (Math.abs(lane) - 1) * 16 : AXIS_Y + 20 + (lane - 1) * 16);

export function HorizonLine({
  items,
  nowMs,
  onSelect,
  onHover,
  highlight,
}: {
  readonly items: readonly TimelineItem[];
  readonly nowMs: number;
  readonly onSelect?: (m: HorizonMarker) => void;
  readonly onHover?: (m: HorizonMarker | null) => void;
  readonly highlight?: {
    readonly hospitalId?: string | null;
    readonly physicianId?: string | null;
  } | null;
}) {
  // Measure the real width so 1 viewBox unit = 1 px: labels keep their true size and the lane placement (px) is exact.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = box.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? DEFAULT_W);
      if (w > 0) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fromMs = nowMs - PAST_MIN * MIN;
  const toMs = nowMs + FUTURE_MIN * MIN;
  const x = (ms: number) => PAD_L + ((Math.max(fromMs, Math.min(toMs, ms)) - fromMs) / (toMs - fromMs)) * (W - PAD_L - PAD_R);
  const nowX = x(nowMs);
  // A deadline already behind the clock is still shown where it fell, labelled overdue (computed, not engine text).
  const markers = toMarkers(items).map((m) => (m.kind === 'action_deadline' && m.tMs < nowMs ? { ...m, label: `overdue · ${m.label}` } : m));
  const placed = placeLabels(markers, x);
  const bands = markers.filter((m) => m.kind === 'surge_band' || m.kind === 'gap_band');
  const stepMin = W < 700 ? 60 : 30;
  const ticks = Array.from({ length: 8 }, (_, i) => Math.ceil(fromMs / (stepMin * MIN)) * stepMin * MIN + i * stepMin * MIN).filter((t) => t <= toMs);
  const isHot = (m: HorizonMarker) => highlight != null && ((highlight.hospitalId != null && m.hospitalIds.includes(highlight.hospitalId)) || (highlight.physicianId != null && m.physicianIds.includes(highlight.physicianId)));
  const summary = markers.map((m) => `${m.label} at ${etHm(m.tMs)}${m.endMs === null ? '' : ` to ${etHm(m.endMs)}`}`).join('; ');
  const act = (m: HorizonMarker) => ({
    tabIndex: 0,
    role: 'button' as const,
    'aria-label': `${m.label}, ${etHm(m.tMs)} ET. ${m.detail}`,
    onClick: () => onSelect?.(m),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect?.(m);
      }
    },
    onMouseEnter: () => onHover?.(m),
    onMouseLeave: () => onHover?.(null),
    onFocus: () => onHover?.(m),
    onBlur: () => onHover?.(null),
    style: { cursor: onSelect === undefined ? 'default' : 'pointer' },
  });
  return (
    <div ref={box} className="w-full">
      <svg data-testid="horizon-line" width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full" role="group" aria-labelledby="hl-title hl-desc">
        <title id="hl-title">Horizon line: now minus 30 to now plus 180 minutes</title>
        <desc id="hl-desc">{summary === '' ? 'Nothing scheduled or projected in the next 180 minutes.' : summary}</desc>
        <defs>
          <pattern id="hl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="none" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-warning)" strokeWidth="2.2" />
          </pattern>
        </defs>
        {/* past segment (faint) and the future axis (the only teal line) */}
        <rect x={PAD_L} y={8} width={nowX - PAD_L} height={H - 16} fill="var(--color-raised)" opacity="0.35" />
        <line x1={PAD_L} x2={nowX} y1={AXIS_Y} y2={AXIS_Y} stroke="var(--color-border)" strokeWidth="2" />
        <line x1={nowX} x2={W - PAD_R} y1={AXIS_Y} y2={AXIS_Y} stroke="var(--color-accent)" strokeWidth="2" />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={AXIS_Y - 3} y2={AXIS_Y + 3} stroke="var(--color-ink3)" strokeWidth="1" />
            <text x={x(t)} y={H - 4} textAnchor="middle" className="num" fontSize="11" fill="var(--color-ink3)">
              {etHm(t)}
            </text>
          </g>
        ))}
        {/* bands: surge hatched above (opacity = P(spike)), gaps red under the line */}
        {bands.map((m) =>
          m.kind === 'surge_band' ? (
            <rect
              key={m.key}
              data-kind="surge_band"
              x={x(m.tMs)}
              y={AXIS_Y - 12}
              width={Math.max(2, x(m.endMs ?? m.tMs) - x(m.tMs))}
              height={10}
              fill="url(#hl-hatch)"
              opacity={Math.max(0.25, Math.min(1, m.value ?? 0.5))}
              stroke={isHot(m) ? 'var(--color-text)' : 'none'}
              {...act(m)}
            >
              <title>{`${m.label}: P(spike) up to ${m.value ?? '?'}. ${m.detail}`}</title>
            </rect>
          ) : (
            <rect key={m.key} data-kind="gap_band" x={x(m.tMs)} y={AXIS_Y + 3} width={Math.max(2, x(m.endMs ?? m.tMs) - x(m.tMs))} height={5} fill="var(--color-critical)" opacity={isHot(m) ? 1 : 0.85} {...act(m)}>
              <title>{`${m.label}: P(gap) up to ${m.value ?? '?'}. ${m.detail}`}</title>
            </rect>
          ),
        )}
        {/* now edge */}
        <line x1={nowX} x2={nowX} y1={8} y2={H - 16} stroke="var(--color-text)" strokeWidth="1.5" />
        <text x={nowX + 4} y={12} fontSize="11" className="num" fill="var(--color-text)">
          now {etHm(nowMs)}
        </text>
        {/* point markers */}
        {placed.map(({ m, x: px, lane }) => {
          const hot = isHot(m);
          const ly = lane === null ? null : laneY(lane);
          const color = m.kind === 'action_deadline' ? 'var(--color-accent)' : m.kind === 'shift_end' ? 'var(--color-warning)' : m.kind.endsWith('expiry') ? 'var(--color-info)' : 'var(--color-text)';
          return (
            <g key={m.key} data-kind={m.kind} data-testid="horizon-marker" opacity={highlight != null && !hot ? 0.45 : 1} {...act(m)}>
              <title>{`${m.label} · ${etHm(m.tMs)} ET · ${m.detail}`}</title>
              {m.kind === 'shift_end' && <path d={`M${px - 4} ${AXIS_Y - 12} L${px} ${AXIS_Y - 12} L${px} ${AXIS_Y} L${px - 4} ${AXIS_Y}`} fill="none" stroke={color} strokeWidth="2" />}
              {(m.kind === 'arrival_confirmed' || m.kind === 'arrival_expected') && (
                <path d={`M${px + 4} ${AXIS_Y} L${px} ${AXIS_Y} L${px} ${AXIS_Y + 12} L${px + 4} ${AXIS_Y + 12}`} fill="none" stroke={color} strokeWidth="2" strokeDasharray={m.kind === 'arrival_expected' ? '2 2' : undefined} />
              )}
              {(m.kind === 'offer_expiry' || m.kind === 'standby_expiry') && <path d={`M${px - 4} ${AXIS_Y + 4} L${px + 4} ${AXIS_Y + 4} L${px - 4} ${AXIS_Y + 14} L${px + 4} ${AXIS_Y + 14} Z`} fill="none" stroke={color} strokeWidth="1.5" />}
              {m.kind === 'action_deadline' && (
                <>
                  <line x1={px} x2={px} y1={AXIS_Y} y2={AXIS_Y - 16} stroke={color} strokeWidth="2" />
                  <path d={`M${px} ${AXIS_Y - 16} L${px + 9} ${AXIS_Y - 12.5} L${px} ${AXIS_Y - 9} Z`} fill={color} />
                </>
              )}
              {ly !== null && (
                <text
                  x={px + (m.kind === 'shift_end' ? -2 : 3)}
                  y={ly}
                  fontSize="11"
                  fill={hot ? 'var(--color-text)' : m.kind === 'action_deadline' ? 'var(--color-accent)' : 'var(--color-muted)'}
                  fontWeight={hot || m.kind === 'action_deadline' ? 600 : 400}
                >
                  {m.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
