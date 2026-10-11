'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { UiRole } from '@/lib/dto';
import { sessionRoles, type SessionRole } from './live';
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
  { href: '/opener', label: 'Opener' },
  { href: '/rewind', label: 'Rewind' },
  { href: '/quality', label: 'Quality' },
  { href: '/architecture', label: 'Architecture' },
  { href: '/admin/dataset', label: 'Dataset' },
];

/** Upstream Event Simulator status (sprint B1): the chip shows while the simulator posted within this window. */
const UPSTREAM_WINDOW_MS = 60_000;
const UPSTREAM_POLL_MS = 10_000;

interface UpstreamStatus {
  readonly enabled: boolean;
  readonly connected: boolean;
}

/** Polls GET /api/simulator/status every 10 s and whenever the store version changes (SSE). */
function useUpstreamStatus(version: number | undefined): UpstreamStatus {
  const [st, setSt] = useState<UpstreamStatus>({ enabled: false, connected: false });
  useEffect(() => {
    let stopped = false;
    const load = () =>
      fetch('/api/simulator/status', { cache: 'no-store' })
        .then(async (r) => {
          if (!r.ok || stopped) return;
          const j = (await r.json()) as { enabled?: boolean; lastSentAtMs?: number | null; nowMs?: number };
          const last = typeof j.lastSentAtMs === 'number' ? j.lastSentAtMs : null;
          const now = typeof j.nowMs === 'number' ? j.nowMs : Date.now();
          setSt({ enabled: j.enabled === true, connected: j.enabled === true && last !== null && now - last <= UPSTREAM_WINDOW_MS });
        })
        .catch(() => {});
    void load();
    const t = setInterval(() => void load(), UPSTREAM_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [version]);
  return st;
}

/**
 * Switching the console to a role needs that role's PIN (OQ-44, D-91): the
 * clinical lead always; the coordinator only when DEMO_MODE is off. The server
 * sets an HttpOnly session cookie (POST /api/auth/session).
 */
const ROLE_LABEL: Record<SessionRole, string> = { coordinator: 'Coordinator', clinical_lead: 'Clinical lead', admin: 'Admin' };

export function PinPrompt({ role = 'clinical_lead', onDone, onCancel }: { readonly role?: SessionRole; readonly onDone: () => void; readonly onCancel: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const label = ROLE_LABEL[role];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70" role="dialog" aria-modal="true" aria-label={`${label} PIN`}>
      <form
        className="w-[360px] rounded-xl border border-border bg-panel p-5 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          void fetch('/api/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, pin }) }).then((r) => (r.ok ? onDone() : setError(r.status === 429 ? 'Too many attempts; wait a minute.' : 'Wrong PIN.')));
        }}
      >
        <div className="text-[13px] font-semibold uppercase tracking-wider text-accent">{label}</div>
        <div className="mt-1 text-[18px] font-semibold">Enter the {role === 'clinical_lead' ? 'lead' : label.toLowerCase()} PIN</div>
        <input data-testid="console-pin" autoFocus inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} className="num mt-3 w-full rounded-md border border-border bg-bg p-2 text-[20px] tracking-[0.3em]" aria-label={`${label} PIN`} />
        {error !== null && <p className="mt-2 text-[14px] text-critical">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button tone="muted" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" testId="console-pin-submit" disabled={pin.trim() === ''}>
            Unlock
          </Button>
        </div>
      </form>
    </div>
  );
}

export function TopBar() {
  const { view, sse, role, setRole, clock, toasts, dismiss } = useLive();
  const path = usePathname();
  const [pinFor, setPinFor] = useState<SessionRole | null>(null);
  const chooseRole = (r: UiRole) => {
    if (r === 'physician') return setRole(r);
    // The coordinator needs no PIN in DEMO_MODE; the clinical lead always does (OQ-44, D-91).
    void sessionRoles().then((s) => ((r === 'coordinator' && s.demoMode) || s.roles.includes(r) ? setRole(r) : setPinFor(r)));
  };
  const upstream = useUpstreamStatus(view?.version);
  const c = view?.clock;
  const playing = c?.mode === 'playing';
  const snapLabel = c === undefined ? '18:20' : etHm(c.snapshotMs);
  return (
    <>
      <header className="flex h-14 min-w-0 items-center gap-3 border-b border-border bg-panel px-3 2xl:gap-5 2xl:px-5">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-[22px] font-bold tracking-tight text-text 2xl:text-[26px]">
            Look<span className="text-accent">ahead</span>
          </span>
          <span className="hidden text-[12px] uppercase tracking-[0.14em] text-muted 2xl:inline">tele-neuro ops</span>
        </Link>

        <div className="flex items-baseline gap-2" data-testid="sim-clock">
          <span className="num text-[28px] font-semibold leading-none text-text 2xl:text-[36px]">{c === undefined ? '--:--:--' : etHms(c.nowMs)}</span>
          <span className="text-[14px] font-semibold text-muted">ET</span>
          <span className={cx('ml-1 text-[12px] font-semibold uppercase tracking-wide', playing ? 'text-ok' : 'text-muted')}>{playing ? `▶ playing ${c?.speed}×` : '⏸ paused'}</span>
        </div>

        <div className="hidden items-center gap-1.5 md:flex">
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
          <Button size="sm" tone="muted" testId="advance-11" title="Past a delivered offer's 10-minute expiry" onClick={() => void clock({ action: 'advance', minutes: 11 })}>
            +11m
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

        <nav className="scroll-thin ml-auto flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap" aria-label="Pages">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={cx('rounded-[2px] px-1.5 py-1 text-[13px] 2xl:px-2 2xl:text-[14px]', path === l.href ? 'bg-raised text-text' : 'text-muted hover:text-text')}>
              {l.label}
            </Link>
          ))}
          {upstream.enabled && (
            <Link href="/simulator" data-testid="nav-simulator" className={cx('rounded-[2px] px-1.5 py-1 text-[13px] 2xl:px-2 2xl:text-[14px]', path === '/simulator' ? 'bg-raised text-text' : 'text-muted hover:text-text')}>
              Simulator
            </Link>
          )}
        </nav>

        <label className="flex items-center gap-2 text-[13px] text-muted">
          Role
          <select
            data-testid="role-switcher"
            value={role}
            onChange={(e) => chooseRole(e.target.value as UiRole)}
            className="rounded-md border border-border bg-raised px-2 py-1 text-[14px] font-semibold text-text"
          >
            <option value="coordinator">Coordinator</option>
            <option value="clinical_lead">Clinical lead</option>
          </select>
        </label>

        {upstream.connected && (
          <Link href="/simulator" data-testid="upstream-chip" title="The upstream event simulator posted a row within the last 60 s" className="rounded border border-ok/50 bg-ok/15 px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-ok whitespace-nowrap">
            Upstream connected
          </Link>
        )}

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
      {view !== null && view.integrity.diffs > 0 && (
        <div role="alert" data-testid="snapshot-mismatch-banner" className="flex items-center gap-3 border-b border-critical/50 bg-critical/15 px-5 py-1.5 text-[14px] text-critical">
          <span className="font-semibold uppercase tracking-wide">Replay differs</span>
          <span>
            Replay differs from your snapshot: <span className="num font-semibold">{view.integrity.diffs}</span> cells ({view.integrity.physicians} physicians, {view.integrity.consults} consults).
          </span>
          <Link href="/integrity" className="font-semibold underline">
            See /integrity
          </Link>
        </div>
      )}
      {pinFor !== null && (
        <PinPrompt
          role={pinFor}
          onDone={() => {
            const r = pinFor;
            setPinFor(null);
            if (r === 'coordinator' || r === 'clinical_lead') setRole(r);
          }}
          onCancel={() => setPinFor(null)}
        />
      )}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </>
  );
}
