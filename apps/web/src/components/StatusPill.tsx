'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { etHms } from '@/lib/format';
import { cx } from './ui';

/**
 * Sprint A6 status pill (bottom-right, every page). Fetches /api/health after
 * mount (never blocks render) and says only what the checks proved: green
 * "Live on AWS" only when the server reports live (BOTH the DynamoDB and the
 * Bedrock checks made a real round trip); otherwise amber "Local engine", with
 * "AWS unreachable" when AWS was configured but a check failed. Click opens
 * the detail modal.
 */

type CheckStatus = 'ok' | 'unavailable' | 'not_configured';

/** Mirror of the /api/health fields this pill reads (client code never imports server modules). */
interface HealthView {
  readonly uptimeMs: number;
  readonly events: number;
  readonly live: boolean;
  readonly region: string | null;
  readonly deployedUrl: string | null;
  readonly store: string;
  readonly checks: {
    readonly dynamo: { readonly status: CheckStatus; readonly latencyMs: number | null; readonly table: string | null; readonly detail: string };
    readonly bedrock: { readonly status: CheckStatus; readonly latencyMs: number | null; readonly modelId: string | null; readonly detail: string };
  };
  readonly lastWebhook: { readonly atMs: number; readonly ok: boolean; readonly status: number; readonly latencyMs: number; readonly error: string | null } | null;
  readonly testReport: {
    readonly generatedAtMs: number;
    readonly ok: boolean;
    readonly command: string;
    readonly total: { readonly files: number; readonly tests: number; readonly passed: number; readonly failed: number; readonly skipped: number; readonly durationMs: number };
  } | null;
}

/** LOOKAHEAD-DEFINED: the pill re-reads health this often (the server caches real AWS checks for 15 s). */
const REFRESH_MS = 60_000;

function uptime(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} d`;
}

const STATUS_WORD: Record<CheckStatus, string> = { ok: 'OK', unavailable: 'UNAVAILABLE', not_configured: 'NOT CONFIGURED' };
const statusTone = (s: CheckStatus) => (s === 'ok' ? 'text-ok' : s === 'unavailable' ? 'text-warning' : 'text-muted');

export function pillText(h: HealthView): { readonly live: boolean; readonly text: string } {
  const { dynamo, bedrock } = h.checks;
  if (h.live) {
    const latency = Math.max(dynamo.latencyMs ?? 0, bedrock.latencyMs ?? 0);
    return { live: true, text: `Live on AWS · ${latency} ms · up ${uptime(h.uptimeMs)} · ${h.events.toLocaleString('en-US')} events` };
  }
  const all = [dynamo.status, bedrock.status];
  if (all.every((s) => s === 'not_configured')) return { live: false, text: 'Local engine' };
  if (all.some((s) => s === 'unavailable')) return { live: false, text: 'Local engine · AWS unreachable' };
  const missing = [dynamo.status === 'not_configured' ? 'DynamoDB' : null, bedrock.status === 'not_configured' ? 'Bedrock' : null].filter((x) => x !== null);
  return { live: false, text: `Local engine · ${missing.join(' and ')} not configured` };
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-2 border-b border-border py-1.5 text-[12px]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </div>
  );
}

function StatusModal({ h, onClose }: { readonly h: HealthView; readonly onClose: () => void }) {
  const { dynamo, bedrock } = h.checks;
  const t = h.testReport;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-bg/70 p-3 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="System status" data-testid="status-modal" className="w-full max-w-[560px] rounded border border-border bg-panel p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted">System status</h2>
          <button type="button" onClick={onClose} className="rounded border border-border px-2 py-0.5 text-[12px] text-muted hover:text-text">
            Close
          </button>
        </div>
        <dl>
          <Row label="Deployed URL">{h.deployedUrl ?? <span className="text-muted">not set (DEPLOYED_URL)</span>}</Row>
          <Row label="AWS region">{h.region ?? <span className="text-muted">not set (AWS_REGION)</span>}</Row>
          <Row label="DynamoDB">
            <span className={cx('font-semibold', statusTone(dynamo.status))}>{STATUS_WORD[dynamo.status]}</span>
            {dynamo.table !== null && <span className="num"> · {dynamo.table}</span>}
            {dynamo.latencyMs !== null && <span className="num"> · {dynamo.latencyMs} ms</span>}
            <div className="text-[11px] text-muted">{dynamo.detail}</div>
          </Row>
          <Row label="Store backend">
            <span className="num">{h.store}</span>
          </Row>
          <Row label="Bedrock">
            <span className={cx('font-semibold', statusTone(bedrock.status))}>{STATUS_WORD[bedrock.status]}</span>
            {bedrock.latencyMs !== null && <span className="num"> · last check {bedrock.latencyMs} ms</span>}
            {bedrock.modelId !== null && <span className="num"> · {bedrock.modelId}</span>}
            <div className="text-[11px] text-muted">{bedrock.detail}</div>
          </Row>
          <Row label="Last webhook">
            {h.lastWebhook === null ? (
              <span className="text-muted">no delivery yet</span>
            ) : (
              <span className="num">
                {h.lastWebhook.ok ? 'delivered' : 'failed'} · HTTP {h.lastWebhook.status} · {h.lastWebhook.latencyMs} ms · {etHms(h.lastWebhook.atMs)} ET{h.lastWebhook.error !== null ? ` · ${h.lastWebhook.error}` : ''}
              </span>
            )}
          </Row>
          <Row label="Last test run">
            {t === null ? (
              <span className="text-muted">no test report yet</span>
            ) : (
              <span>
                <span className={cx('font-semibold', t.ok ? 'text-ok' : 'text-critical')}>{t.ok ? 'PASS' : 'FAIL'}</span>{' '}
                <span className="num">
                  {t.total.passed}/{t.total.tests} passed, {t.total.failed} failed, {t.total.skipped} skipped in {t.total.files} files
                </span>
                <div className="text-[11px] text-muted">
                  {new Date(t.generatedAtMs).toISOString().replace('T', ' ').slice(0, 16)} UTC · {t.command}
                </div>
              </span>
            )}
          </Row>
          <Row label="Uptime · events">
            <span className="num">
              {uptime(h.uptimeMs)} · {h.events.toLocaleString('en-US')} events
            </span>
          </Row>
        </dl>
        <Link href="/architecture" className="mt-3 inline-block text-[12px] text-info underline" onClick={onClose}>
          Architecture
        </Link>
      </div>
    </div>
  );
}

/** LOOKAHEAD-DEFINED: bottom strip reserved for the pill (its height plus the bottom offset), published as --pill-h. */
const PILL_STRIP_PX = 28;

export function SystemStatusPill() {
  const pathname = usePathname();
  const [h, setH] = useState<HealthView | null>(null);
  const [open, setOpen] = useState(false);
  const hidden = pathname !== null && pathname.startsWith('/embed');
  // Reserve the strip from mount (before health answers) so the console does not jump when the pill appears.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--pill-h', hidden ? '0px' : `${PILL_STRIP_PX}px`);
  }, [hidden]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/health', { cache: 'no-store' })
        .then(async (r) => (r.ok ? ((await r.json()) as HealthView) : null))
        .then((v) => {
          if (!cancelled && v !== null && typeof v.checks === 'object') setH(v);
        })
        .catch(() => {
          // offline: keep the last answer
        });
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  if (hidden || h === null) return null;
  const p = pillText(h);
  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-border bg-panel px-3 text-[11px] text-muted" style={{ height: PILL_STRIP_PX }} data-testid="status-line">
        <button
          type="button"
          data-testid="status-pill"
          data-live={p.live ? 'true' : 'false'}
          onClick={() => setOpen(true)}
          title={`${p.text}. Open system status.`}
          className={cx('flex min-w-0 items-center gap-1.5 font-semibold', p.live ? 'text-ok' : 'text-warning')}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
            {p.live ? <circle cx="4" cy="4" r="3.2" fill="currentColor" /> : <path d="M4 0.8 L7.4 7.2 L0.6 7.2 Z" fill="currentColor" />}
          </svg>
          <span className="num truncate">{p.text}</span>
        </button>
        <span className="ml-auto hidden items-center gap-3 sm:flex">
          <button type="button" className="hover:text-text" onClick={() => window.dispatchEvent(new Event('lookahead:palette'))}>
            <span className="num">⌘K</span> palette
          </button>
          <button type="button" className="hover:text-text" onClick={() => window.dispatchEvent(new Event('lookahead:shortcuts'))}>
            <span className="num">?</span> shortcuts
          </button>
          <span>
            <span className="num">T</span> theme
          </span>
        </span>
      </div>
      {open && <StatusModal h={h} onClose={() => setOpen(false)} />}
    </>
  );
}
