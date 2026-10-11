'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Component kit (UI pass, docs/DESIGN.md). Sharp 2 px radius, no shadows,
 * 4 px grid, status never carried by color alone (every state has a shape
 * and a word). Colors are the semantic tokens of src/ui/tokens.ts:
 * critical = alarm, warning = caution, accent = action (teal), ok, info;
 * text / muted / ink3 = ink, ink-2, ink-3.
 */

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

// ------------------------------------------------------------------ Button

export type ButtonKind = 'primary' | 'secondary' | 'destructive' | 'ghost';

const BUTTON: Record<ButtonKind, string> = {
  primary: 'bg-accent text-bg border-accent hover:brightness-110',
  secondary: 'bg-transparent text-text border-border hover:border-accent',
  destructive: 'bg-transparent text-critical border-critical hover:bg-critical/10',
  ghost: 'bg-transparent text-muted border-transparent hover:text-text',
};

export function Button({ kind = 'secondary', phone = false, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { readonly kind?: ButtonKind; readonly phone?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[2px] border font-semibold transition-[filter,border-color,background-color] disabled:cursor-not-allowed disabled:opacity-50',
        phone ? 'min-h-12 w-full px-4 text-[16px]' : 'h-8 px-3 text-[13px]',
        BUTTON[kind],
        className,
      )}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ Chip

export type Tone = 'critical' | 'warning' | 'ok' | 'info' | 'accent' | 'neutral';

const CHIP: Record<Tone, string> = {
  critical: 'border-critical/60 text-critical',
  warning: 'border-warning/60 text-warning',
  ok: 'border-ok/60 text-ok',
  info: 'border-info/60 text-info',
  accent: 'border-accent/60 text-accent',
  neutral: 'border-border text-muted',
};

export function Chip({ tone = 'neutral', id = false, children, title }: { readonly tone?: Tone; readonly id?: boolean; readonly children: ReactNode; readonly title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-[2px] border px-1.5 py-px leading-4', id ? 'num text-[11px] text-muted border-border' : 'text-[11px] font-semibold uppercase tracking-wide', !id && CHIP[tone])}>
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ PriorityGlyph

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export const PRIORITY_TONE: Record<Priority, Tone> = { P1: 'critical', P2: 'warning', P3: 'info', P4: 'neutral' };
export const PRIORITY_WORD: Record<Priority, string> = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' };
export const severityPriority = (s: string): Priority => (s === 'critical' ? 'P1' : s === 'high' ? 'P2' : s === 'medium' ? 'P3' : 'P4');

/** Shape carries the priority without color: P1 filled diamond, P2 filled triangle, P3 hollow square, P4 hollow circle. */
export function PriorityGlyph({ p, size = 12 }: { readonly p: Priority; readonly size?: number }) {
  const c = { P1: 'var(--color-critical)', P2: 'var(--color-warning)', P3: 'var(--color-info)', P4: 'var(--color-muted)' }[p];
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 12 12" role="img" aria-label={`${PRIORITY_WORD[p]} priority`} className="shrink-0">
      <title>{`${PRIORITY_WORD[p]} priority`}</title>
      {p === 'P1' && <path d="M6 0.5 L11.5 6 L6 11.5 L0.5 6 Z" fill={c} />}
      {p === 'P2' && <path d="M6 1 L11.5 11 L0.5 11 Z" fill={c} />}
      {p === 'P3' && <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke={c} strokeWidth="1.6" />}
      {p === 'P4' && <circle cx="6" cy="6" r="4.5" fill="none" stroke={c} strokeWidth="1.6" />}
    </svg>
  );
}

// ------------------------------------------------------------------ StatusPill

/** Every standby/offer state with a shape and a word (never color alone). */
export const STATUS_STYLE: Record<string, { readonly word: string; readonly tone: Tone; readonly shape: 'dot' | 'ring' | 'square' | 'bar' | 'cross' }> = {
  proposed: { word: 'Proposed', tone: 'neutral', shape: 'ring' },
  awaiting_approval: { word: 'Awaiting approval', tone: 'warning', shape: 'ring' },
  approved: { word: 'Approved', tone: 'info', shape: 'dot' },
  prealert_delivered: { word: 'Pre-alert sent', tone: 'info', shape: 'dot' },
  delivered: { word: 'Sent', tone: 'info', shape: 'dot' },
  ready: { word: 'Acknowledged', tone: 'accent', shape: 'dot' },
  acknowledged: { word: 'Acknowledged', tone: 'accent', shape: 'dot' },
  activation_recommended: { word: 'Activation recommended', tone: 'warning', shape: 'bar' },
  activation_proposed: { word: 'Activation proposed', tone: 'warning', shape: 'ring' },
  activation_delivered: { word: 'Activation sent', tone: 'info', shape: 'dot' },
  activated: { word: 'Active', tone: 'ok', shape: 'square' },
  accepted: { word: 'Accepted', tone: 'ok', shape: 'square' },
  released: { word: 'Released', tone: 'neutral', shape: 'square' },
  declined: { word: 'Declined', tone: 'critical', shape: 'cross' },
  not_tonight: { word: 'Declined', tone: 'critical', shape: 'cross' },
  rejected: { word: 'Rejected', tone: 'critical', shape: 'cross' },
  expired: { word: 'Expired', tone: 'neutral', shape: 'cross' },
  cancelled: { word: 'Cancelled', tone: 'neutral', shape: 'cross' },
};

export function StatusPill({ status, testId }: { readonly status: string; readonly testId?: string }) {
  const s = STATUS_STYLE[status] ?? { word: status.replace(/_/g, ' '), tone: 'neutral' as Tone, shape: 'ring' as const };
  const color = `var(--color-${s.tone === 'neutral' ? 'muted' : s.tone})`;
  return (
    <span data-testid={testId} className={cx('inline-flex items-center gap-1.5 rounded-[2px] border px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide', CHIP[s.tone])}>
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
        {s.shape === 'dot' && <circle cx="4" cy="4" r="3.2" fill={color} />}
        {s.shape === 'ring' && <circle cx="4" cy="4" r="3" fill="none" stroke={color} strokeWidth="1.4" />}
        {s.shape === 'square' && <rect x="0.8" y="0.8" width="6.4" height="6.4" fill={color} />}
        {s.shape === 'bar' && <rect x="0.5" y="2.5" width="7" height="3" fill={color} />}
        {s.shape === 'cross' && <path d="M1 1 L7 7 M7 1 L1 7" stroke={color} strokeWidth="1.5" />}
      </svg>
      {s.word}
    </span>
  );
}

// ------------------------------------------------------------------ Panel, SectionTitle, Rule

export function SectionTitle({ children, right, id }: { readonly children: ReactNode; readonly right?: ReactNode; readonly id?: string | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2">
      <h2 id={id} className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
        {children}
      </h2>
      {right}
    </div>
  );
}

export function Rule({ className }: { readonly className?: string }) {
  return <hr className={cx('border-0 border-t border-border', className)} />;
}

export function KitPanel({ title, right, children, className, testId, labelledBy }: { readonly title?: ReactNode; readonly right?: ReactNode; readonly children: ReactNode; readonly className?: string; readonly testId?: string; readonly labelledBy?: string }) {
  return (
    <section data-testid={testId} aria-labelledby={labelledBy} className={cx('flex min-h-0 flex-col rounded-[2px] border border-border bg-panel', className)}>
      {title !== undefined && (
        <SectionTitle id={labelledBy} right={right}>
          {title}
        </SectionTitle>
      )}
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ AnalogBar, Pips, Sparkline

/** A count against its normal band: the bar turns caution/alarm only when abnormal (above p90, or at/over the alarm threshold). */
export function AnalogBar({ value, normalMax, alarmAt, max, history = [], label }: { readonly value: number; readonly normalMax: number | null; readonly alarmAt?: number; readonly max: number; readonly history?: readonly number[]; readonly label: string }) {
  const W = 120;
  const H = 10;
  const sx = (v: number) => (Math.min(v, max) / Math.max(max, 1)) * W;
  const abnormal = normalMax !== null && value > normalMax;
  const alarm = alarmAt !== undefined && value >= alarmAt;
  const fill = alarm ? 'var(--color-critical)' : abnormal ? 'var(--color-warning)' : 'var(--color-muted)';
  return (
    <svg width={W} height={H + 4} viewBox={`0 0 ${W} ${H + 4}`} role="img" aria-label={`${label}: ${value}${normalMax === null ? '' : `, normal up to ${normalMax}`}`}>
      <title>{`${label}: ${value}${normalMax === null ? '' : ` (normal up to ${normalMax})`}`}</title>
      <rect x="0" y="2" width={W} height={H} fill="var(--color-raised)" />
      {normalMax !== null && <rect x="0" y="2" width={sx(normalMax)} height={H} fill="var(--color-border)" />}
      <rect x="0" y="4" width={sx(value)} height={H - 4} fill={fill} />
      {history.map((h, i) => (
        <line key={i} x1={sx(h)} x2={sx(h)} y1="0" y2="3" stroke="var(--color-ink3)" strokeWidth="1" />
      ))}
      {normalMax !== null && <line x1={sx(normalMax)} x2={sx(normalMax)} y1="0" y2={H + 4} stroke="var(--color-text)" strokeWidth="1" />}
    </svg>
  );
}

/** Coverage pips: filled = available, hollow = required but missing. */
export function Pips({ available, required, label }: { readonly available: number; readonly required: number; readonly label: string }) {
  const n = Math.max(available, required);
  return (
    <span role="img" aria-label={`${label}: ${available} available of ${required} required`} className="inline-flex items-center gap-[3px]">
      {Array.from({ length: n }, (_, i) => (
        <svg key={i} width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          {i < available ? <circle cx="4" cy="4" r="3.5" fill={i < required ? 'var(--color-text)' : 'var(--color-muted)'} /> : <circle cx="4" cy="4" r="3" fill="none" stroke="var(--color-critical)" strokeWidth="1.4" />}
        </svg>
      ))}
    </span>
  );
}

export function Sparkline({ values, width = 80, height = 18, label }: { readonly values: readonly number[]; readonly width?: number; readonly height?: number; readonly label: string }) {
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * width},${height - (v / max) * (height - 2) - 1}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${values.join(', ')}`}>
      <title>{label}</title>
      <polyline points={pts} fill="none" stroke="var(--color-muted)" strokeWidth="1.2" />
    </svg>
  );
}

// ------------------------------------------------------------------ states

export function EmptyState({ title, detail }: { readonly title: string; readonly detail?: string }) {
  return (
    <div className="px-4 py-6" data-testid="empty-state">
      <p className="text-[15px] text-text">{title}</p>
      {detail !== undefined && <p className="mt-1 text-[13px] text-muted">{detail}</p>}
    </div>
  );
}

export function ErrorState({ title, detail }: { readonly title: string; readonly detail?: string }) {
  return (
    <div role="alert" className="border-l-2 border-critical px-4 py-3" data-testid="error-state">
      <p className="text-[15px] font-semibold text-critical">{title}</p>
      {detail !== undefined && <p className="mt-1 text-[13px] text-muted">{detail}</p>}
    </div>
  );
}

/** Loading: quiet static rule lines (no shimmer). */
export function LoadingRules({ lines = 3, label = 'Loading' }: { readonly lines?: number; readonly label?: string }) {
  return (
    <div className="space-y-3 px-4 py-4" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-px bg-border" style={{ width: `${90 - i * 15}%` }} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

// ------------------------------------------------------------------ Modal / Drawer shell

export function Modal({ title, onClose, children, testId, wide = false }: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode; readonly testId?: string; readonly wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4" onClick={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()} role="presentation">
      <div role="dialog" aria-modal="true" aria-label={title} data-testid={testId} className={cx('max-h-[90vh] w-full overflow-y-auto rounded-[2px] border border-border bg-panel', wide ? 'max-w-3xl' : 'max-w-md')} onClick={(e) => e.stopPropagation()}>
        <SectionTitle
          right={
            <button type="button" onClick={onClose} className="text-[13px] text-muted hover:text-text" aria-label="Close">
              Close
            </button>
          }
        >
          {title}
        </SectionTitle>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
