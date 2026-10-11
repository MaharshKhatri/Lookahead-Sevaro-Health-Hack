'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResponse, PublicOfferDTO } from '@/lib/dto';
import { plainError } from '@/lib/errors';
import { countdown, etHm, etHms } from '@/lib/format';
import { newCommandId, useStoreVersion } from './live';
import { Button, Chip, cx } from './ui';

/**
 * /offer/[id]: the off-shift physician's phone (brief: "A clear offer:
 * hospitals, hours, start time, why they were asked"; "Accept or decline from
 * a phone; nothing else"). Shows only the delivered, PHI-checked message from
 * GET /api/offers/:id and a live countdown (sim clock) to expiry.
 */

export function PhoneOffer({ offerId, token, initial }: { readonly offerId: string; readonly token: string | null; readonly initial: PublicOfferDTO | null }) {
  const [offer, setOffer] = useState(initial);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(() => {
    if (token === null) return;
    void fetch(`/api/offers/${encodeURIComponent(offerId)}?t=${encodeURIComponent(token)}`, { cache: 'no-store' }).then(async (r) => {
      if (!alive.current) return;
      if (r.ok) {
        setOffer((await r.json()) as PublicOfferDTO);
        setFetchedAt(Date.now());
      } else setOffer(null);
    });
  }, [offerId, token]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  useStoreVersion(load);

  // Smooth countdown between server updates while the sim clock plays.
  const playing = offer?.clockMode === 'playing';
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [playing]);

  async function respond(response: 'accept' | 'decline') {
    if (offer === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lookahead-role': 'physician', 'x-lookahead-actor-id': offer.physicianId },
        body: JSON.stringify({ command: { type: 'respond', offerId, response, commandId: newCommandId() }, token }),
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

  if (offer === null) {
    return (
      <main className="mx-auto max-w-[390px] p-6">
        <p className="text-[18px] text-muted">This offer link is not valid.</p>
      </main>
    );
  }

  void tick;
  const elapsed = playing && fetchedAt > 0 ? (Date.now() - fetchedAt) * offer.clockSpeed : 0;
  const left = offer.msUntilExpiry === null ? null : Math.max(0, offer.msUntilExpiry - elapsed);
  const terminal = !offer.canRespond;
  const urgent = left !== null && left < 120_000;

  return (
    <main className="mx-auto flex min-h-screen max-w-[390px] flex-col px-5 pb-8 pt-6" data-testid="phone-offer" data-status={offer.status}>
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-bold">
          Look<span className="text-accent">ahead</span>
        </span>
        <span className="num text-[13px] text-muted">{etHms(offer.nowMs)} ET</span>
      </div>

      <h1 className="mt-6 text-[28px] font-bold leading-tight" data-testid="phone-headline">
        {offer.headline}
      </h1>
      <p className="num mt-2 text-[20px] text-text" data-testid="phone-window">
        {etHm(offer.startMs)}–{etHm(offer.endMs)} ET
      </p>

      {offer.canRespond && left !== null && (
        <div className={cx('mt-4 rounded-[2px] border p-4 text-center', urgent ? 'border-critical bg-critical/10' : 'border-warning/60 bg-warning/10')}>
          <div className="text-[13px] font-semibold uppercase tracking-wider text-muted">Expires in</div>
          <div className={cx('num text-[52px] font-semibold leading-none', urgent ? 'text-critical' : 'text-warning')} data-testid="phone-countdown">
            {countdown(left)}
          </div>
        </div>
      )}

      {offer.messageLines !== null && (
        <div className="mt-5 space-y-2 rounded-[2px] border border-border bg-panel p-4 text-[18px] leading-snug" data-testid="phone-message">
          {offer.messageLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}

      {offer.messageLines !== null && <p className="mt-2 text-[13px] text-muted" data-testid="phone-no-phi">No case information is included.</p>}

      {offer.reason !== null && <p className="mt-4 text-[17px] text-muted">{offer.reason}</p>}

      {error !== null && (
        <div role="alert" className="mt-4 rounded-[2px] border border-critical/70 bg-critical/10 p-3 text-[15px] text-critical" data-testid="phone-error">
          {error}
        </div>
      )}

      <div className="mt-auto pt-8">
        {offer.canRespond ? (
          <div className="grid grid-cols-1 gap-3">
            <Button size="lg" tone="accent" className="min-h-[56px] w-full" testId="offer-accept" disabled={busy} onClick={() => void respond('accept')}>
              Accept
            </Button>
            <Button size="lg" tone="muted" className="min-h-[56px] w-full" testId="offer-decline" disabled={busy} onClick={() => void respond('decline')}>
              Decline
            </Button>
          </div>
        ) : (
          terminal && (
            <div className="text-center">
              <Chip tone={offer.status === 'accepted' ? 'ok' : offer.status === 'delivered' ? 'warning' : 'muted'} className="px-3 py-1.5 text-[15px]">
                <span data-testid="phone-status">{offer.status.toUpperCase()}</span>
              </Chip>
            </div>
          )
        )}
      </div>
    </main>
  );
}
