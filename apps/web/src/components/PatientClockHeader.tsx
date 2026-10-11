'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AiBanner } from './AiBanner';
import { cx } from './ui';

/**
 * Patient clock (sprint A2): a band on every page naming the single unassigned
 * stroke consult that most needs a human now. Every value comes from
 * GET /api/patient-clock (engine clinical/patientClock.ts); the only thing
 * computed here is the elapsed display, (sim now - unassignedSinceMs), where
 * sim now follows the sim clock: fixed while paused, nowMs + real elapsed x
 * speed while playing. Refetched on every /api/stream message (debounced 200 ms).
 */

/** Mirror of server/patientClock.ts PatientClockDTO (client code never imports server modules). */
interface PatientClockView {
  readonly consultId: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly unassignedSinceMs: number;
  readonly unassignedMin: number;
  readonly routingFailureCount: number;
  readonly credentialedRoutableNow: number;
  readonly credentialedTotal: number;
  readonly severity: 'critical' | 'warning';
  readonly rankReason: string;
  readonly neuronsAtRiskEstimate: number;
  readonly candidateCount: number;
}

interface PatientClockPayload {
  readonly clock: PatientClockView | null;
  readonly nowMs: number;
  readonly clockMode: 'paused' | 'playing';
  readonly clockSpeed: number;
  readonly version: number;
}

/** LOOKAHEAD-DEFINED: how long the green "all assigned" bar stays before collapsing. */
const CLEAR_BAR_MS = 10_000;
const TICK_MS = 1_000;
const REFETCH_DEBOUNCE_MS = 200;

/** Pages where the chrome is not shown: partner embeds render inside someone else's frame. */
const hiddenOn = (path: string | null) => path !== null && path.startsWith('/embed');
/**
 * Physician-facing notification pages (tokenized offer and standby links) never show the clinical band:
 * brief "No patient information in any notification. Hospital names, hours and start time only."
 */
const clinicalHiddenOn = (path: string | null) => path !== null && (path.startsWith('/offer/') || path.startsWith('/standby/'));

/** "12:05" (MM:SS); minutes are not wrapped at 60 so a long wait reads as a long wait. */
function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** "23.8M" / "142M": the engine's illustrative estimate in millions. */
function millions(n: number): string {
  const m = n / 1_000_000;
  return m < 10 ? m.toFixed(1) : String(Math.round(m));
}

/**
 * Lightweight SSE subscription for the chrome (it lives outside LiveProvider):
 * refetch on ANY stream message, including the hello frame, debounced. That
 * closes the gap between the first fetch and the stream opening.
 */
function useStreamRefetch(onMessage: () => void, debounceMs = REFETCH_DEBOUNCE_MS): void {
  const cb = useRef(onMessage);
  useEffect(() => {
    cb.current = onMessage;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource('/api/stream');
    es.onmessage = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => cb.current(), debounceMs);
    };
    return () => {
      if (timer !== null) clearTimeout(timer);
      es.close();
    };
  }, [debounceMs]);
}

function usePatientClock(): PatientClockPayload | null {
  const [data, setData] = useState<{ payload: PatientClockPayload; fetchedAtMs: number } | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const refetch = useCallback(() => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    fetch('/api/patient-clock', { cache: 'no-store', signal: ac.signal })
      .then(async (r) => (r.ok ? ((await r.json()) as PatientClockPayload) : null))
      .then((payload) => {
        if (payload !== null && typeof payload.nowMs === 'number') setData({ payload, fetchedAtMs: Date.now() });
      })
      .catch(() => {
        // aborted or offline: keep the last answer; the next SSE version refetches
      });
  }, []);
  useEffect(() => {
    refetch();
    return () => inflight.current?.abort();
  }, [refetch]);
  useStreamRefetch(refetch);
  // Re-render every second so the elapsed display moves with the sim clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, []);
  if (data === null) return null;
  const { payload, fetchedAtMs } = data;
  const simNow = payload.clockMode === 'playing' ? payload.nowMs + (Date.now() - fetchedAtMs) * payload.clockSpeed : payload.nowMs;
  return { ...payload, nowMs: simNow };
}

/** Scroll to the attention card that carries this consult on "/", else go to "/". */
function useJumpToConsult(): (consultId: string, hospitalName: string) => void {
  const pathname = usePathname();
  const router = useRouter();
  return useCallback(
    (consultId: string, hospitalName: string) => {
      if (pathname !== '/') {
        router.push('/');
        return;
      }
      const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-attention-id]'));
      // The card that names the consult; failing that, the first card about its hospital.
      const card = cards.find((el) => (el.textContent ?? '').includes(consultId)) ?? cards.find((el) => (el.textContent ?? '').includes(hospitalName));
      if (card === undefined) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('ring-2', 'ring-critical');
      setTimeout(() => card.classList.remove('ring-2', 'ring-critical'), 2_000);
    },
    [pathname, router],
  );
}

function ClockBand({ c, nowMs, paused }: { readonly c: PatientClockView; readonly nowMs: number; readonly paused: boolean }) {
  const jump = useJumpToConsult();
  const critical = c.severity === 'critical';
  return (
    <div
      data-testid="patient-clock"
      data-severity={c.severity}
      data-consult-id={c.consultId}
      title={c.rankReason}
      className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 border-t-2 px-3 py-1.5', critical ? 'border-critical bg-critical/[0.14]' : 'border-warning bg-warning/[0.14]')}
    >
      <BrainGlyph critical={critical} />
      <button
        type="button"
        onClick={() => jump(c.consultId, c.hospitalName)}
        aria-label={`${c.severity} stroke consult unassigned at ${c.hospitalName}. ${c.rankReason} Go to the attention card.`}
        className="flex min-w-0 items-baseline gap-2 text-left"
      >
        <span className="hidden text-[13px] text-muted sm:inline">Stroke consult unassigned at</span>
        <span data-testid="patient-clock-hospital" className="min-w-0 truncate text-[18px] font-semibold text-text">
          {c.hospitalName}
        </span>
      </button>
      <span className="flex items-baseline gap-1.5">
        <span data-testid="patient-clock-elapsed" className={cx('num text-[22px] font-semibold leading-none sm:text-[28px]', critical ? 'text-critical' : 'text-warning')}>
          {mmss(nowMs - c.unassignedSinceMs)}
        </span>
        {paused && (
          <span data-testid="patient-clock-paused" className="rounded-[2px] border border-border px-1 text-[11px] text-muted">
            Sim clock paused
          </span>
        )}
      </span>
      <span className="hidden flex-wrap items-center gap-2 text-[13px] sm:flex">
        <span data-testid="patient-clock-available" className="rounded-[2px] border border-border bg-panel px-1.5 py-px text-muted">
          <span className={cx('num', c.credentialedRoutableNow === 0 ? 'text-critical' : 'text-text')}>{c.credentialedRoutableNow}</span> of <span className="num text-text">{c.credentialedTotal}</span> credentialed physicians available
        </span>
        <span data-testid="patient-clock-failures" className="rounded-[2px] border border-border bg-panel px-1.5 py-px text-muted">
          <span className="num text-text">{c.routingFailureCount}</span> routing {c.routingFailureCount === 1 ? 'attempt' : 'attempts'} failed
        </span>
      </span>
      <Link href="/clinical-sources" className="hidden text-[15px] text-text underline sm:inline decoration-border underline-offset-2 hover:decoration-text" data-testid="patient-clock-neurons" title="Illustrative extrapolation (Saver 2006); not a clinical outcome measurement">
        ~<span className="num">{millions(c.neuronsAtRiskEstimate)}</span>M neurons at risk (estimate)
      </Link>
    </div>
  );
}

/** Brain outline (UI pass): the band's glyph; shape, not color, says "stroke". */
function BrainGlyph({ critical }: { readonly critical: boolean }) {
  return (
    <svg width="20" height="18" viewBox="0 0 20 18" aria-hidden="true" className="shrink-0">
      <path
        d="M7 2.2C5.3 1.6 3.6 2.6 3.4 4.3 1.9 4.8 1.3 6.6 2.2 7.9 1.2 9.2 1.6 11.1 3.1 11.7 3.1 13.6 5 14.9 6.8 14.2 7.6 15.7 9.4 15.9 10 14.6V3.3C9.6 2.2 8.3 1.7 7 2.2ZM13 2.2C14.7 1.6 16.4 2.6 16.6 4.3 18.1 4.8 18.7 6.6 17.8 7.9 18.8 9.2 18.4 11.1 16.9 11.7 16.9 13.6 15 14.9 13.2 14.2 12.4 15.7 10.6 15.9 10 14.6V3.3C10.4 2.2 11.7 1.7 13 2.2Z"
        fill="none"
        stroke={critical ? 'var(--color-critical)' : 'var(--color-warning)'}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClearBar() {
  return (
    <div data-testid="patient-clock-clear" className="flex h-6 items-center gap-2 border-b border-border bg-panel px-3 text-[13px] text-muted">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 6.5 L5 9.5 L10 3" fill="none" stroke="var(--color-ok)" strokeWidth="1.8" />
      </svg>
      All stroke consults currently assigned
    </div>
  );
}

export function PatientClockHeader() {
  const data = usePatientClock();
  const clock = data?.clock ?? null;
  const phase: 'loading' | 'clock' | 'clear' = data === null ? 'loading' : clock !== null ? 'clock' : 'clear';
  // null: not in the clear phase; > 0: green bar until then; 0: collapsed.
  const [clearUntil, setClearUntil] = useState<number | null>(null);
  // Every transition into "nothing on the clock" (including the first answer) shows the green bar for CLEAR_BAR_MS.
  useEffect(() => {
    if (phase === 'clock') setClearUntil(null);
    else if (phase === 'clear') setClearUntil((prev) => prev ?? Date.now() + CLEAR_BAR_MS);
  }, [phase]);
  useEffect(() => {
    if (clearUntil === null || clearUntil === 0) return;
    const t = setTimeout(() => setClearUntil(0), Math.max(0, clearUntil - Date.now()));
    return () => clearTimeout(t);
  }, [clearUntil]);
  if (data === null) return null;
  if (clock !== null) return <ClockBand c={clock} nowMs={data.nowMs} paused={data.clockMode === 'paused'} />;
  return clearUntil !== null && clearUntil > 0 ? <ClearBar /> : null;
}

/**
 * Top chrome for every page: the patient clock and the AI banner. Its height is
 * published as --chrome-h on <html> so full-viewport consoles size themselves
 * to the remaining space (CommandCenter, and layout.tsx for the other h-screen pages).
 */
export function TopChrome() {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement | null>(null);
  const hidden = hiddenOn(pathname);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (hidden || el === null) {
      root.style.setProperty('--chrome-h', '0px');
      return;
    }
    const set = () => root.style.setProperty('--chrome-h', `${el.getBoundingClientRect().height}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hidden]);
  if (hidden) return null;
  return (
    <div ref={ref} data-testid="top-chrome" className="relative z-30">
      {!clinicalHiddenOn(pathname) && <PatientClockHeader />}
      <AiBanner />
    </div>
  );
}
