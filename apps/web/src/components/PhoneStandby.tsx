'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResponse, PublicStandbyDTO } from '@/lib/dto';
import { plainError } from '@/lib/errors';
import { countdown, etHm, etHms } from '@/lib/format';
import { newCommandId, useStoreVersion } from './live';
import { Button, Chip, cx } from './ui';

/**
 * /standby/[id]: the off-shift physician's phone for the standby network
 * (Phase 7, D-90). Shows the delivered pre-alert with "I can be ready" / "Not
 * tonight", then, once an activation is delivered, the activation text with
 * Accept / Decline. No case information (engine PHI guard on every string);
 * terminal states are shown plainly.
 */

const STATUS_WORD: Readonly<Record<string, string>> = {
  prealert_delivered: 'PRE-ALERT',
  acknowledged: 'ON STANDBY',
  activation_delivered: 'ACTIVATION REQUEST',
  activated: 'ACTIVATED',
  declined: 'NOT TONIGHT',
  activation_declined: 'ACTIVATION DECLINED',
  released: 'RELEASED',
  expired: 'EXPIRED',
  cancelled: 'WITHDRAWN',
  rejected: 'NOT SENT',
};

export function PhoneStandby({ standbyId, token, initial }: { readonly standbyId: string; readonly token: string | null; readonly initial: PublicStandbyDTO | null }) {
  const [sb, setSb] = useState(initial);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(() => {
    if (token === null) return;
    void fetch(`/api/standby/${encodeURIComponent(standbyId)}?t=${encodeURIComponent(token)}`, { cache: 'no-store' }).then(async (r) => {
      if (!alive.current) return;
      if (r.ok) {
        setSb((await r.json()) as PublicStandbyDTO);
        setFetchedAt(Date.now());
      } else setSb(null);
    });
  }, [standbyId, token]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  useStoreVersion(load);

  const playing = sb?.clockMode === 'playing';
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [playing]);

  async function respond(kind: 'standby' | 'activation', response: string) {
    if (sb === null) return;
    setBusy(true);
    setError(null);
    try {
      const command = kind === 'standby' ? { type: 'respondStandby', standbyId, response, commandId: newCommandId() } : { type: 'respondActivation', standbyId, response, commandId: newCommandId() };
      const r = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lookahead-role': 'physician', 'x-lookahead-actor-id': sb.physicianId },
        body: JSON.stringify({ command, token }),
      });
      const b = (await r.json()) as CommandResponse;
      if (!b.ok) setError(plainError(b.code, b.message));
      load();
    } catch (e) {
      setError(plainError('INTERNAL', e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (sb === null) {
    return (
      <main className="mx-auto max-w-[390px] p-6">
        <p className="text-[18px] text-muted" data-testid="standby-invalid">
          This standby link is not valid.
        </p>
      </main>
    );
  }

  void tick;
  const elapsed = playing && fetchedAt > 0 ? (Date.now() - fetchedAt) * sb.clockSpeed : 0;
  const left = sb.msUntilExpiry === null ? null : Math.max(0, sb.msUntilExpiry - elapsed);
  const urgent = left !== null && left < 120_000;
  const word = STATUS_WORD[sb.status] ?? sb.status.toUpperCase().replace(/_/g, ' ');

  return (
    <main className="mx-auto flex min-h-screen max-w-[390px] flex-col px-5 pb-8 pt-6" data-testid="phone-standby" data-status={sb.status}>
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-bold">
          Look<span className="text-accent">ahead</span> <span className="text-[12px] font-normal uppercase tracking-wider text-muted">standby</span>
        </span>
        <span className="num text-[13px] text-muted">{etHms(sb.nowMs)} ET</span>
      </div>

      <div className="mt-5 flex items-center gap-2">
        <Chip tone={sb.status === 'activated' || sb.status === 'acknowledged' ? 'ok' : sb.canRespond ? 'warning' : 'muted'} className="rounded-full px-3 py-1.5 text-[14px]">
          <span data-testid="standby-status">{word}</span>
        </Chip>
      </div>
      <h1 className="mt-3 text-[26px] font-bold leading-tight" data-testid="standby-headline">
        {sb.headline}
      </h1>
      <p className="num mt-2 text-[20px] text-text" data-testid="standby-window">
        {etHm(sb.startMs)}–{etHm(sb.endMs)} ET
      </p>
      <p className="mt-1 text-[13px] text-muted">No case information is included.</p>

      {sb.canRespond && left !== null && (
        <div className={cx('mt-4 rounded-[2px] border p-4 text-center', urgent ? 'border-critical bg-critical/10' : 'border-warning/60 bg-warning/10')}>
          <div className="text-[13px] font-semibold uppercase tracking-wider text-muted">Expires in</div>
          <div className={cx('num text-[52px] font-semibold leading-none', urgent ? 'text-critical' : 'text-warning')} data-testid="standby-countdown">
            {countdown(left)}
          </div>
        </div>
      )}

      {sb.prealertLines !== null && (
        <section className="mt-5 rounded-[2px] border border-border bg-panel p-4 text-[17px] leading-snug" data-testid="standby-prealert">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Pre-alert</div>
          {sb.prealertLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </section>
      )}

      {sb.activationLines !== null && (
        <section className={cx('mt-4 rounded-[2px] border p-4 text-[18px] leading-snug', sb.respond === 'activation' ? 'border-accent bg-accent/10' : 'border-border bg-panel')} data-testid="standby-activation">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Activation</div>
          {sb.activationLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          {sb.logOnByMs !== null && (
            <p className="num mt-2 text-[14px] text-muted">
              log on by {etHm(sb.logOnByMs)} ET · until {etHm(sb.endMs)} ET
            </p>
          )}
        </section>
      )}

      {sb.releaseLines !== null && (
        <section className="mt-4 rounded-[2px] border border-border bg-panel p-4 text-[17px] leading-snug" data-testid="standby-release">
          {sb.releaseLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </section>
      )}

      {sb.reason !== null && <p className="mt-4 text-[16px] text-muted">{sb.reason}</p>}

      {error !== null && (
        <div role="alert" className="mt-4 rounded-[2px] border border-critical/70 bg-critical/10 p-3 text-[15px] text-critical" data-testid="standby-error">
          {error}
        </div>
      )}

      <div className="mt-auto pt-8">
        {sb.respond === 'standby' && (
          <div className="grid grid-cols-1 gap-3">
            <Button size="lg" tone="accent" className="min-h-[56px] w-full" testId="standby-ready" disabled={busy} onClick={() => void respond('standby', 'ready')}>
              I can be ready
            </Button>
            <Button size="lg" tone="muted" className="min-h-[56px] w-full" testId="standby-not-tonight" disabled={busy} onClick={() => void respond('standby', 'not_tonight')}>
              Not tonight
            </Button>
          </div>
        )}
        {sb.respond === 'activation' && (
          <div className="grid grid-cols-1 gap-3">
            <Button size="lg" tone="accent" className="min-h-[56px] w-full" testId="activation-accept" disabled={busy} onClick={() => void respond('activation', 'accept')}>
              Accept
            </Button>
            <Button size="lg" tone="muted" className="min-h-[56px] w-full" testId="activation-decline" disabled={busy} onClick={() => void respond('activation', 'decline')}>
              Decline
            </Button>
          </div>
        )}
        {sb.respond === null && <p className="text-center text-[13px] text-muted">Nothing to answer right now. This page updates by itself.</p>}
      </div>
    </main>
  );
}
