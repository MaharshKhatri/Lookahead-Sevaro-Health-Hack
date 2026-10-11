'use client';

import type { ReactNode } from 'react';
import type { CellClass, EvidenceDTO } from '@/lib/dto';
import { etHms } from '@/lib/format';

/**
 * Small display primitives. Status is never color-only: every chip carries a
 * word (CRITICAL, AT RISK, HARD GAP, DEADLOCK, OK, ...).
 */

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

type Tone = 'critical' | 'warning' | 'ok' | 'info' | 'accent' | 'muted';

// Outline chips (UI pass, D-98): a tinted fill under colored text fell below WCAG AA (axe color-contrast); the border carries the tone.
const TONE: Record<Tone, string> = {
  critical: 'text-critical border-critical/60',
  warning: 'text-warning border-warning/60',
  ok: 'text-ok border-ok/60',
  info: 'text-info border-info/60',
  accent: 'text-accent border-accent/60',
  muted: 'bg-raised text-muted border-border',
};

export function Chip({ tone, children, className, title }: { readonly tone: Tone; readonly children: ReactNode; readonly className?: string; readonly title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wide leading-none whitespace-nowrap', TONE[tone], className)}>
      {children}
    </span>
  );
}

export const severityTone = (s: string): Tone => (s === 'critical' ? 'critical' : s === 'high' ? 'warning' : s === 'medium' ? 'info' : 'muted');

export function SeverityChip({ severity }: { readonly severity: string }) {
  return <Chip tone={severityTone(severity)}>{severity.toUpperCase()}</Chip>;
}

export const CLASS_WORD: Record<CellClass, string> = { OK: 'OK', AT_RISK: 'AT RISK', HARD_GAP: 'HARD GAP', DEADLOCK: 'DEADLOCK' };
export const classTone = (c: CellClass): Tone => (c === 'OK' ? 'ok' : c === 'AT_RISK' ? 'warning' : 'critical');

export function ClassChip({ cls }: { readonly cls: CellClass }) {
  return <Chip tone={classTone(cls)}>{CLASS_WORD[cls]}</Chip>;
}

export const NEED_WORD: Record<string, string> = { DEADLOCK_NOW: 'DEADLOCK', HARD_GAP: 'HARD GAP', AT_RISK: 'AT RISK' };
export const needTone = (k: string): Tone => (k === 'AT_RISK' ? 'warning' : 'critical');

export function NeedChip({ kind }: { readonly kind: string }) {
  return <Chip tone={needTone(kind)}>{NEED_WORD[kind] ?? kind}</Chip>;
}

export function StrokeTag() {
  return (
    <Chip tone="critical" className="bg-critical text-bg border-critical">
      STROKE
    </Chip>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  proposed: 'info',
  approved: 'info',
  sent: 'info',
  delivered: 'warning',
  accepted: 'ok',
  declined: 'muted',
  expired: 'critical',
  cancelled: 'muted',
  superseded: 'muted',
  rejected: 'critical',
};

export function StatusPill({ status, className }: { readonly status: string; readonly className?: string }) {
  return (
    <Chip tone={STATUS_TONE[status] ?? 'muted'} className={cx('rounded-full px-2.5 py-1 text-[13px]', className)}>
      <span data-testid="offer-status">{status.toUpperCase()}</span>
    </Chip>
  );
}

/** Event-id chip; hover shows event type and event time (ET). */
export function EvidenceChip({ e }: { readonly e: EvidenceDTO }) {
  return (
    <span className="group relative inline-block">
      <span tabIndex={0} className="num cursor-help rounded border border-border bg-raised px-1.5 py-0.5 text-[12px] text-muted outline-none hover:border-accent hover:text-text focus:border-accent">
        {e.eventId}
      </span>
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-0 z-30 mb-1 hidden whitespace-nowrap rounded border border-border bg-bg px-2 py-1 text-[12px] text-text shadow-lg group-focus-within:block group-hover:block">
        <span className="num">{e.eventType}</span> · <span className="num">{etHms(e.eventTimeMs)} ET</span>
      </span>
    </span>
  );
}

export function Panel({ title, right, children, className, testId }: { readonly title: ReactNode; readonly right?: ReactNode; readonly children: ReactNode; readonly className?: string; readonly testId?: string }) {
  return (
    <section data-testid={testId} className={cx('flex min-h-0 flex-col rounded-lg border border-border bg-panel', className)}>
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</h2>
        <div className="ml-auto flex items-center gap-2">{right}</div>
      </header>
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = 'accent',
  title,
  className,
  testId,
  size = 'md',
  type = 'button',
  autoFocus,
  confirmTrigger,
}: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly tone?: 'accent' | 'critical' | 'muted' | 'ok';
  readonly title?: string;
  readonly className?: string;
  readonly testId?: string;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly type?: 'button' | 'submit';
  readonly autoFocus?: boolean;
  /** Marks the first-click button of a confirm-before-send pair (lead inbox "A" key). */
  readonly confirmTrigger?: boolean;
}) {
  const tones = {
    accent: 'bg-accent text-bg hover:bg-accent/85 border-accent',
    ok: 'bg-ok text-bg hover:bg-ok/85 border-ok',
    critical: 'bg-transparent text-critical border-critical/70 hover:bg-critical/15',
    // Secondary = outline (UI pass, D-98).
    muted: 'bg-transparent text-text border-border hover:border-accent',
  };
  const sizes = { sm: 'px-2 py-1 text-[13px]', md: 'px-3 py-1.5 text-[14px]', lg: 'min-h-12 px-5 py-3 text-[18px]' };
  return (
    <button
      type={type}
      data-testid={testId}
      title={title}
      disabled={disabled}
      onClick={onClick}
      autoFocus={autoFocus}
      data-confirm-trigger={confirmTrigger === true ? 'true' : undefined}
      className={cx('rounded-[2px] border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40', tones[tone], sizes[size], className)}
    >
      {children}
    </button>
  );
}

export function Toasts({ toasts, dismiss }: { readonly toasts: readonly { id: number; kind: 'ok' | 'error' | 'info'; text: string }[]; readonly dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[420px] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-testid={`toast-${t.kind}`}
          className={cx(
            'pointer-events-auto flex items-start gap-3 rounded-lg border bg-raised px-4 py-3 text-[14px] shadow-xl',
            t.kind === 'error' ? 'border-critical/70' : t.kind === 'ok' ? 'border-ok/70' : 'border-info/70',
          )}
        >
          <Chip tone={t.kind === 'error' ? 'critical' : t.kind === 'ok' ? 'ok' : 'info'}>{t.kind === 'error' ? 'REFUSED' : t.kind === 'ok' ? 'DONE' : 'INFO'}</Chip>
          <span className="flex-1 leading-snug">{t.text}</span>
          <button type="button" className="text-muted hover:text-text" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Short hospital label for chips ("Suncrest Medical Pavilion" -> "Suncrest"). */
export const shortName = (name: string) => name.split(' ')[0] ?? name;
