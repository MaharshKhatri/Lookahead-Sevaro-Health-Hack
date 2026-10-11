'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { etHms } from '@/lib/format';
import { useLive } from './live';
import { Chip, Panel, cx } from './ui';

/**
 * STRESS TEST drawer (LOOKAHEAD-DEFINED): one button per server-defined
 * stress action, grouped "Prove it" / "Break it", each run rendered as a
 * result card (newest first). Every label, description, number and sentence
 * comes from GET/POST /api/stress at render time; the only fixed text here is
 * the two group titles and the field captions. The drawer is non-modal: the
 * console behind it stays usable, and its live view follows the store via SSE
 * (LiveProvider), so nothing here refetches /api/view.
 */

// ---- Wire contract (mirrors the /api/stress route; kept local so this client file imports no server code) ----

export type StressGroup = 'prove' | 'break';

export interface StressActionDTO {
  readonly id: string;
  readonly group: StressGroup;
  readonly label: string;
  readonly description: string;
}

export interface StressTotalsDTO {
  readonly handled: number;
  readonly errors: number;
  readonly seconds: number;
  readonly byAction: Readonly<Record<string, number>>;
}

export interface StressResultDTO {
  readonly id: string;
  readonly action: string;
  readonly group: StressGroup;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly startedAtMs: number;
  readonly summary: string;
  readonly details: readonly string[];
  readonly metrics: Readonly<Record<string, number | string>>;
  readonly error: string | null;
}

export interface StressCatalogDTO {
  readonly actions: readonly StressActionDTO[];
  readonly totals: StressTotalsDTO;
}

export interface StressRunDTO {
  readonly result: StressResultDTO;
  readonly totals: StressTotalsDTO;
}

interface ApiError {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

/** One rendered run: the server result, or the transport/API error that replaced it. */
export interface RunCard {
  readonly key: string;
  readonly actionId: string;
  readonly label: string;
  readonly group: StressGroup;
  readonly seed: number | null;
  readonly clickedAtMs: number;
  readonly result: StressResultDTO | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

/** The action whose runs carry a seed (contract: random_chaos takes `seed`). */
const SEEDED_ACTION = 'random_chaos';
/** Cards kept on screen; older runs stay counted in the server totals. */
const MAX_CARDS = 40;

const GROUPS: readonly { readonly group: StressGroup; readonly title: string }[] = [
  { group: 'prove', title: 'Prove it' },
  { group: 'break', title: 'Break it' },
];

// ---- Formatting (display only; no rounding beyond what a reader needs) ----

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}

function fmtMs(ms: number): string {
  return ms < 10 ? (Math.round(ms * 10) / 10).toFixed(1) : String(Math.round(ms));
}

function fmtSeconds(s: number): string {
  if (s < 1) return s.toFixed(2);
  if (s < 100) return s.toFixed(1);
  return String(Math.round(s));
}

/** "eventsInjected" / "events_injected" -> "events injected". */
const metricLabel = (k: string) =>
  k
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function parseTotals(x: unknown): StressTotalsDTO | null {
  if (!isObj(x)) return null;
  const { handled, errors, seconds, byAction } = x;
  if (typeof handled !== 'number' || typeof errors !== 'number' || typeof seconds !== 'number') return null;
  return { handled, errors, seconds, byAction: isObj(byAction) ? (byAction as Record<string, number>) : {} };
}

function parseResult(x: unknown): StressResultDTO | null {
  if (!isObj(x)) return null;
  if (typeof x.id !== 'string' || typeof x.action !== 'string' || typeof x.ok !== 'boolean' || typeof x.summary !== 'string') return null;
  return {
    id: x.id,
    action: x.action,
    group: x.group === 'break' ? 'break' : 'prove',
    ok: x.ok,
    latencyMs: typeof x.latencyMs === 'number' ? x.latencyMs : Number.NaN,
    startedAtMs: typeof x.startedAtMs === 'number' ? x.startedAtMs : Number.NaN,
    summary: x.summary,
    details: Array.isArray(x.details) ? x.details.filter((d): d is string => typeof d === 'string') : [],
    metrics: isObj(x.metrics) ? (Object.fromEntries(Object.entries(x.metrics).filter(([, v]) => typeof v === 'number' || typeof v === 'string')) as Record<string, number | string>) : {},
    error: typeof x.error === 'string' ? x.error : null,
  };
}

function apiError(body: unknown, status: number): ApiError {
  if (isObj(body) && typeof body.code === 'string') return { ok: false, code: body.code, message: typeof body.message === 'string' ? body.message : '' };
  return { ok: false, code: status === 0 ? 'NETWORK' : `HTTP_${status}`, message: status === 0 ? 'The server did not answer.' : `The server answered ${status} without an error body.` };
}

// ---- Pieces ----

/** Shape + word, never color alone: filled circle = OK, triangle = ERROR / FAILED. */
function ResultPill({ ok, word }: { readonly ok: boolean; readonly word: string }) {
  return (
    <Chip tone={ok ? 'ok' : 'critical'} className="rounded-full px-2 py-1">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
        {ok ? <circle cx="5" cy="5" r="4" fill="currentColor" /> : <path d="M5 0.8 L9.4 9 L0.6 9 Z" fill="currentColor" />}
      </svg>
      <span data-testid="stress-result-state">{word}</span>
    </Chip>
  );
}

function MetricsTable({ metrics }: { readonly metrics: Readonly<Record<string, number | string>> }) {
  const rows = Object.entries(metrics);
  if (rows.length === 0) return null;
  return (
    <table className="mt-2 w-full border-collapse text-[12px]" data-testid="stress-metrics">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-t border-border/60">
            <th scope="row" className="py-0.5 pr-3 text-left font-normal text-muted">
              {metricLabel(k)}
            </th>
            <td className="num py-0.5 text-right text-text">{typeof v === 'number' ? fmtNum(v) : v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ResultCard({ card }: { readonly card: RunCard }) {
  const r = card.result;
  const ok = r !== null && r.ok;
  const word = ok ? 'OK' : r === null || r.error !== null ? 'ERROR' : 'FAILED';
  const errorText = r === null ? `${card.failure?.code ?? 'ERROR'}: ${card.failure?.message ?? ''}`.trim() : r.ok ? null : (r.error ?? 'The check did not pass; see the lines below.');
  const startedAt = r !== null && Number.isFinite(r.startedAtMs) ? r.startedAtMs : card.clickedAtMs;
  return (
    <li
      data-testid="stress-result"
      data-action={card.actionId}
      data-ok={ok ? 'true' : 'false'}
      {...(card.seed === null ? {} : { 'data-seed': String(card.seed) })}
      className={cx('rounded-md border bg-raised p-3', ok ? 'border-border' : 'border-critical/60')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ResultPill ok={ok} word={word} />
        <span className="text-[14px] font-semibold leading-tight text-text">{card.label}</span>
        <span className="ml-auto flex items-center gap-2 text-[12px] text-muted">
          {r !== null && Number.isFinite(r.latencyMs) && (
            <span data-testid="stress-latency" className="num text-text">
              {fmtMs(r.latencyMs)} ms
            </span>
          )}
          <span className="num">{etHms(startedAt)} ET</span>
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Chip tone={card.group === 'prove' ? 'info' : 'warning'}>{card.group === 'prove' ? 'PROVE' : 'BREAK'}</Chip>
        {card.seed !== null && (
          <span className="num rounded border border-border px-1.5 py-0.5 text-[11px] text-muted" data-testid="stress-seed">
            seed {card.seed}
          </span>
        )}
        {r !== null && <span className="num text-[11px] text-muted">{r.id}</span>}
      </div>
      {r !== null && r.summary !== '' && (
        <p className="mt-2 text-[13px] leading-snug text-text" data-testid="stress-summary">
          {r.summary}
        </p>
      )}
      {errorText !== null && (
        <p className="mt-2 text-[13px] leading-snug text-critical" data-testid="stress-error" role="status">
          {errorText}
        </p>
      )}
      {r !== null && r.details.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[12px] leading-snug text-muted" data-testid="stress-details">
          {r.details.map((d, i) => (
            // Detail lines may repeat; the position keeps keys unique within one card.
            <li key={`${i}-${d}`}>· {d}</li>
          ))}
        </ul>
      )}
      {r !== null && <MetricsTable metrics={r.metrics} />}
    </li>
  );
}

export function ActionButton({ action, running, nextSeed, onRun }: { readonly action: StressActionDTO; readonly running: boolean; readonly nextSeed: number | null; readonly onRun: (a: StressActionDTO) => void }) {
  return (
    <button
      type="button"
      data-testid={`stress-action-${action.id}`}
      disabled={running}
      aria-busy={running}
      onClick={() => onRun(action)}
      className={cx(
        'w-full rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-wait',
        running ? 'border-accent/60 bg-accent/10' : 'border-border bg-raised hover:border-accent',
      )}
    >
      <span className="flex items-center gap-2">
        <span className="text-[14px] font-semibold text-text">{action.label}</span>
        {nextSeed !== null && !running && <span className="num text-[11px] text-muted">next seed {nextSeed}</span>}
        {running && (
          <span className="ml-auto flex items-center gap-1.5 text-[12px] text-accent">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
            running
          </span>
        )}
      </span>
      <span className="mt-0.5 block text-[12px] leading-snug text-muted">{action.description}</span>
    </button>
  );
}

// ---- Drawer ----

export function StressPanel({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const { role } = useLive();
  const [actions, setActions] = useState<readonly StressActionDTO[] | null>(null);
  const [totals, setTotals] = useState<StressTotalsDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const [cards, setCards] = useState<readonly RunCard[]>([]);
  const [chaosRuns, setChaosRuns] = useState(0);
  const [panelRuns, setPanelRuns] = useState(0);
  const runCount = useRef(0);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch('/api/stress', { cache: 'no-store' });
      const body: unknown = await r.json().catch(() => null);
      if (!r.ok || !isObj(body) || !Array.isArray(body.actions)) {
        const e = apiError(body, r.status);
        setLoadError(`${e.code}: ${e.message}`);
        return;
      }
      setActions(
        body.actions.filter((a): a is StressActionDTO => isObj(a) && typeof a.id === 'string' && typeof a.label === 'string' && (a.group === 'prove' || a.group === 'break')).map((a) => ({ ...a, description: typeof a.description === 'string' ? a.description : '' })),
      );
      const t = parseTotals(body.totals);
      if (t !== null) setTotals(t);
    } catch (e) {
      setLoadError(`NETWORK: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Fetch the catalog and the current totals each time the drawer opens (other tabs may have run actions).
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Esc closes; focus moves into the drawer when it opens and back to where it was when it closes.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (before?.isConnected === true) before.focus();
    };
  }, [open, onClose]);

  const run = useCallback(
    async (action: StressActionDTO) => {
      let seed: number | null = null;
      if (action.id === SEEDED_ACTION) {
        // Seed = this browser's chaos-run counter (1, 2, 3, ...): reproducible after a demo reset.
        seed = chaosRuns + 1;
        setChaosRuns(seed);
      }
      setRunning((s) => new Set(s).add(action.id));
      const clickedAtMs = Date.now();
      runCount.current += 1;
      const key = `run-${runCount.current}`;
      let card: RunCard;
      try {
        const r = await fetch('/api/stress', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-lookahead-role': role },
          body: JSON.stringify(seed === null ? { action: action.id } : { action: action.id, seed }),
        });
        const body: unknown = await r.json().catch(() => null);
        const result = r.ok && isObj(body) ? parseResult(body.result) : null;
        if (result === null) {
          const e = r.ok ? { code: 'BAD_RESPONSE', message: 'The server answered without a stress result.' } : apiError(body, r.status);
          card = { key, actionId: action.id, label: action.label, group: action.group, seed, clickedAtMs, result: null, failure: { code: e.code, message: e.message } };
        } else {
          card = { key, actionId: action.id, label: action.label, group: action.group, seed, clickedAtMs, result, failure: null };
        }
        const t = isObj(body) ? parseTotals(body.totals) : null;
        if (t !== null) setTotals(t);
      } catch (e) {
        card = { key, actionId: action.id, label: action.label, group: action.group, seed, clickedAtMs, result: null, failure: { code: 'NETWORK', message: e instanceof Error ? e.message : String(e) } };
      }
      setCards((cs) => [card, ...cs].slice(0, MAX_CARDS));
      setPanelRuns((n) => n + 1);
      setRunning((s) => {
        const n = new Set(s);
        n.delete(action.id);
        return n;
      });
    },
    [chaosRuns, role],
  );

  // Keys typed inside the drawer stay here (J/K/Enter drive the console's next-best-action queue); Esc still reaches the window.
  const contain = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape') e.stopPropagation();
  };

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="false" aria-label="Stress test" onKeyDown={contain} className="pointer-events-none fixed inset-y-0 right-0 z-40 flex w-[480px] max-w-[calc(100vw-1rem)] p-2">
      <Panel
        testId="stress-panel"
        className="pointer-events-auto h-full w-full shadow-2xl"
        title="Stress test"
        right={
          <button ref={closeRef} type="button" data-testid="stress-close" onClick={onClose} aria-label="Close the stress test panel (Esc)" className="rounded border border-border px-2 py-0.5 text-[12px] text-muted hover:border-accent hover:text-text">
            Close <span className="num">Esc</span>
          </button>
        }
      >
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <p className="border-b border-border px-4 py-2 text-[12px] leading-snug text-muted">Each action runs on the server. The console behind this panel stays usable and updates on its own.</p>
          {loadError !== null && (
            <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-[13px] text-critical" data-testid="stress-load-error">
              <span className="flex-1">Could not load the stress actions. {loadError}</span>
              <button type="button" onClick={() => void load()} className="rounded border border-critical/60 px-2 py-0.5 text-[12px] hover:bg-critical/15">
                Retry
              </button>
            </div>
          )}
          {actions === null && loadError === null && <p className="px-4 py-3 text-[13px] text-muted">Loading stress actions…</p>}
          {actions !== null &&
            GROUPS.map(({ group, title }) => {
              const list = actions.filter((a) => a.group === group);
              if (list.length === 0) return null;
              return (
                <section key={group} className="border-b border-border px-4 py-3" data-testid={`stress-group-${group}`}>
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</h3>
                  <ul className="space-y-1.5">
                    {list.map((a) => (
                      <li key={a.id}>
                        <ActionButton action={a} running={running.has(a.id)} nextSeed={a.id === SEEDED_ACTION ? chaosRuns + 1 : null} onRun={(x) => void run(x)} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          <section className="px-4 py-3" aria-live="polite">
            <h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">
              Results
              {panelRuns > MAX_CARDS && (
                <span className="num normal-case tracking-normal">
                  latest {MAX_CARDS} of {panelRuns} runs from this panel
                </span>
              )}
            </h3>
            {cards.length === 0 ? (
              <p className="text-[13px] text-muted">No runs yet from this panel.</p>
            ) : (
              <ol className="space-y-2">
                {cards.map((c) => (
                  <ResultCard key={c.key} card={c} />
                ))}
              </ol>
            )}
          </section>
        </div>
        <footer data-testid="stress-footer" data-handled={totals?.handled ?? ''} data-errors={totals?.errors ?? ''} className="border-t border-border px-4 py-2 text-[13px] text-muted">
          {totals === null ? (
            <span>{loadError === null ? 'Loading totals…' : 'Totals unavailable: the server did not answer.'}</span>
          ) : (
            <>
              <span className="num text-text">{totals.handled}</span> {plural(totals.handled, 'stress event', 'stress events')} handled in <span className="num text-text">{fmtSeconds(totals.seconds)}</span>s ·{' '}
              <span className={cx('num', totals.errors > 0 ? 'font-semibold text-critical' : 'text-text')} data-testid="stress-errors">
                {totals.errors}
              </span>{' '}
              <span className={totals.errors > 0 ? 'text-critical' : undefined}>{plural(totals.errors, 'error', 'errors')}</span>
            </>
          )}
        </footer>
      </Panel>
    </div>
  );
}
