'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { UiRole } from '@/lib/dto';
import { etHm, etHms } from '@/lib/format';
import { useLive } from './live';
import { Button, Toasts, cx } from './ui';

/**
 * TOP BAR: wordmark, sim clock (ET), clock controls, stale-feed banner, SSE
 * status, demo role switcher and links. The clock is the server's sim clock;
 * every control is a POST /api/clock.
 */

const SPEEDS = [1, 10, 60] as const;
const LINKS = [
  { href: '/', label: 'Command' },
  { href: '/state', label: 'State' },
  { href: '/integrity', label: 'Integrity' },
  { href: '/inject', label: 'Inject' },
  { href: '/lead', label: 'Lead inbox' },
];

export function TopBar() {
  const { view, sse, role, setRole, clock, toasts, dismiss } = useLive();
  const path = usePathname();
  const c = view?.clock;
  const playing = c?.mode === 'playing';
  const snapLabel = c === undefined ? '18:20' : etHm(c.snapshotMs);
  return (
    <>
      <header className="flex h-[72px] items-center gap-5 border-b border-border bg-panel px-5">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-[26px] font-bold tracking-tight text-text">
            Look<span className="text-accent">ahead</span>
          </span>
          <span className="hidden text-[12px] uppercase tracking-[0.14em] text-muted xl:inline">tele-neuro ops</span>
        </Link>

        <div className="flex items-baseline gap-2" data-testid="sim-clock">
          <span className="num text-[38px] font-semibold leading-none text-text">{c === undefined ? '--:--:--' : etHms(c.nowMs)}</span>
          <span className="text-[14px] font-semibold text-muted">ET</span>
          <span className={cx('ml-1 text-[12px] font-semibold uppercase tracking-wide', playing ? 'text-ok' : 'text-muted')}>{playing ? `▶ playing ${c?.speed}×` : '⏸ paused'}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button size="sm" tone="muted" testId="clock-toggle" title={playing ? 'Pause the sim clock' : 'Play the sim clock'} onClick={() => void clock({ action: playing ? 'pause' : 'play' })}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </Button>
          <div className="flex overflow-hidden rounded-md border border-border">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void clock({ action: 'set', speed: s })}
                className={cx('num px-2 py-1 text-[13px] font-semibold', c?.speed === s ? 'bg-accent text-bg' : 'bg-raised text-muted hover:text-text')}
                aria-pressed={c?.speed === s}
              >
                {s}×
              </button>
            ))}
          </div>
          <Button size="sm" tone="muted" onClick={() => void clock({ action: 'advance', minutes: -5 })}>
            −5m
          </Button>
          <Button size="sm" tone="muted" onClick={() => void clock({ action: 'advance', minutes: 5 })}>
            +5m
          </Button>
          <Button size="sm" tone="muted" testId="jump-1900" onClick={() => void clock({ action: 'jump', to: '19:00' })}>
            Jump 19:00
          </Button>
          <Button
            size="sm"
            tone="critical"
            testId="reset"
            title="Clear injected events and the action log; clock back to the reference instant, paused"
            onClick={() => {
              void fetch('/api/demo/reset', { method: 'POST' }).then(() => clock({ action: 'pause' }));
            }}
          >
            Reset {snapLabel}
          </Button>
        </div>

        <nav className="ml-auto flex items-center gap-1">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={cx('rounded px-2 py-1 text-[14px]', path === l.href ? 'bg-raised text-text' : 'text-muted hover:text-text')}>
              {l.label}
            </Link>
          ))}
        </nav>

        <label className="flex items-center gap-2 text-[13px] text-muted">
          Role
          <select
            data-testid="role-switcher"
            value={role}
            onChange={(e) => setRole(e.target.value as UiRole)}
            className="rounded-md border border-border bg-raised px-2 py-1 text-[14px] font-semibold text-text"
          >
            <option value="coordinator">Coordinator</option>
            <option value="clinical_lead">Clinical lead</option>
          </select>
        </label>

        <span className="flex items-center gap-1.5 text-[12px] text-muted" title={`Live updates (SSE): ${sse}`} data-testid="sse-status" data-status={sse}>
          <span className={cx('inline-block h-2.5 w-2.5 rounded-full', sse === 'open' ? 'bg-ok' : sse === 'connecting' ? 'bg-info' : 'bg-warning')} />
          {sse === 'open' ? 'LIVE' : sse === 'connecting' ? 'CONNECTING' : 'RECONNECTING'}
        </span>
      </header>
      {view?.noNewEventsSince !== undefined && (
        <div role="status" data-testid="stale-banner" className="flex items-center gap-3 border-b border-warning/40 bg-warning/12 px-5 py-1.5 text-[14px] text-warning">
          <span className="font-semibold uppercase tracking-wide">Feed quiet</span>
          <span>
            No new Sevaro events since <span className="num font-semibold">{etHms(view.noNewEventsSince)}</span> — state is frozen at last known activity
          </span>
        </div>
      )}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </>
  );
}
