'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { LedgerRowDTO, OfferDTO, TrapDTO, ViewDTO, WhatIfDTO, WhatIfRowDTO } from '@/lib/dto';
import { countdown, etEnd, etHm } from '@/lib/format';
import { useLive } from './live';
import { Button, Chip, NeedChip, StatusPill, cx, shortName } from './ui';

/**
 * ACT tabs: LEDGER (brief "show every off-shift physician considered and the
 * rule each one passed or failed"), TRAP (brief "Show how you handle the
 * split-shift trap"), WHAT-IF (projected coverage before/after), OFFERS (the
 * closed loop: status, expiry countdown, allowed actions, QR to the phone view).
 */

// ------------------------------------------------------------------ LEDGER

export function LedgerTab({ rows }: { readonly rows: readonly LedgerRowDTO[] }) {
  return (
    <div className="space-y-2" data-testid="ledger">
      <p className="text-[13px] text-muted">
        {rows.length} off-shift physicians considered · {rows.filter((r) => r.eligible).length} eligible. Six brief rules + two offer limits, each with its numbers.
      </p>
      {rows.map((r) => (
        <div key={r.physicianId} data-testid="ledger-row" data-eligible={r.eligible} className={cx('rounded-lg border p-2.5', r.eligible ? 'border-ok/70 bg-ok/8' : 'border-border bg-raised/40')}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[15px] font-semibold text-text">{r.name}</span>
            <span className="num text-[12px] text-muted">{r.physicianId}</span>
            <span className="ml-auto">
              {r.eligible ? <Chip tone="ok">ELIGIBLE #{r.rank}</Chip> : <Chip tone="critical">EXCLUDED · {r.failedRules.length} rule{r.failedRules.length === 1 ? '' : 's'}</Chip>}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {r.rules.map((x) => (
              <span
                key={x.rule}
                title={`${x.label}: ${x.detail}`}
                className={cx(
                  'num rounded border px-1.5 py-0.5 text-[12px] leading-tight',
                  x.pass === true && 'border-ok/40 text-ok',
                  x.pass === false && 'border-critical/70 bg-critical/15 font-semibold text-critical',
                  x.pass === null && 'border-border text-muted',
                )}
              >
                {x.chip} {x.pass === true ? '✓' : x.pass === false ? '✗' : ''}
              </span>
            ))}
          </div>
          {r.eligible && r.window !== null && (
            <div className="mt-1.5 text-[12px] text-muted">
              window <span className="num text-text">{etHm(r.window.startMs)}–{etHm(r.window.endMs)}</span> ({r.window.effectiveMinutes} min after {r.window.minutesToOnline} min to come online) · value <span className="num text-text">{r.value}</span> · binding cap {r.window.bindingCap.replace(/_/g, ' ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ TRAP

const MITIGATION: Record<TrapDTO['recommended'], string> = { scope: 'SCOPE', seed: 'SEED', scope_and_seed: 'SCOPE + SEED' };

export function TrapTab({ trap, names }: { readonly trap: TrapDTO | null; readonly names: ReadonlyMap<string, string> }) {
  if (trap === null) return <p className="text-muted">No split-shift joiner to analyze at this instant.</p>;
  const sorted = [...trap.seedBasis].sort((a, b) => a.consults - b.consults);
  const name = (id: string) => names.get(id) ?? id;
  const list = (rows: TrapDTO['before'], after: boolean) => (
    <ul className="space-y-1">
      {rows.map((r) => {
        const out = after && !r.inScope;
        return (
          <li key={r.hospitalId} data-testid={after ? 'trap-after' : 'trap-before'} data-first-pick={r.firstPick} data-in-scope={r.inScope} className={cx('flex items-start gap-2 text-[13px]', out && 'text-muted line-through decoration-critical decoration-2')} title={r.why}>
            {r.firstPick ? <Chip tone={after ? 'ok' : 'critical'}>1ST PICK</Chip> : <Chip tone="muted">{out ? 'OUT' : 'NOT 1ST'}</Chip>}
            <span className="leading-tight">
              {shortName(name(r.hospitalId))} <span className="num text-[11px] text-muted">{r.hospitalId}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="space-y-3" data-testid="trap">
      <p className="text-[13px] leading-snug text-muted">
        Brief: a mid-shift joiner starts at 0 consults, so routing rules 3–4 send them nearly every call at every credentialed hospital. {trap.name ?? trap.physicianId} would start at{' '}
        <span className="num text-text">{etHm(trap.startMs)}</span> ({trap.dayShift ? 'day' : 'night'} shift: low volume ≤ <span className="num text-text">{trap.lowVolumeLimit}</span>).
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-critical/50 bg-critical/8 p-2.5">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-critical">
            Before · <span className="num">0</span> consults
          </div>
          {list(trap.before, false)}
        </div>
        <div className="rounded-lg border border-ok/50 bg-ok/8 p-2.5">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ok">
            After {MITIGATION[trap.recommended]} · <span className="num">{trap.seededConsultCount}</span>
          </div>
          {list(trap.after, true)}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-raised/50 p-2.5 text-[13px]" data-testid="trap-seed">
        <div className="mb-1 font-semibold text-text">Seed = median (floor) of on-shift consult counts</div>
        <div className="num text-muted">
          median({sorted.map((s) => s.consults).join(', ')}) = <span className="text-[16px] font-semibold text-accent">{trap.seededConsultCount}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-muted">
          {sorted.map((s) => (
            <span key={s.physicianId} className="num">
              {s.physicianId} {s.consults}
            </span>
          ))}
        </div>
        <div className="mt-1 text-[12px] text-muted">
          {trap.seededConsultCount} &gt; {trap.lowVolumeLimit}: no low-volume priority. Scope: {(trap.scopeHospitalIds ?? trap.credentialedHospitalIds).join(', ')}
          {trap.credentialedOutsideScope.length > 0 && <> · excluded though credentialed: {trap.credentialedOutsideScope.map((h) => shortName(name(h))).join(', ')}</>}
        </div>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-[13px] text-text/85">
        {trap.trapWhy.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ WHAT-IF

const OUTCOME_TONE = { closed: 'ok', downgraded: 'info', shortened: 'warning', unchanged: 'muted' } as const;

function WhatIfRow({ r }: { readonly r: WhatIfRowDTO }) {
  return (
    <div data-testid="whatif-row" data-outcome={r.outcome} className="rounded-md border border-border bg-raised/40 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <NeedChip kind={r.kind} />
        <span className="text-[14px] font-semibold">{shortName(r.hospitalName)}</span>
        <span className="num text-[12px] text-muted">
          {etHm(r.startMs)}–{etEnd(r.endMs)}
        </span>
        <span className="ml-auto">
          <Chip tone={OUTCOME_TONE[r.outcome as keyof typeof OUTCOME_TONE] ?? 'muted'}>{r.outcome.toUpperCase()}</Chip>
        </span>
      </div>
      <div className="mt-1 text-[12px] text-muted">
        {r.remainingMinutes !== null && r.outcome !== 'unchanged' && (
          <span className="num mr-2 text-[13px] text-text">
            {r.beforeMinutes} → {r.remainingMinutes} min {r.kind.replace('_NOW', '').replace('_', ' ').toLowerCase()}
          </span>
        )}
        {r.detail}
      </div>
    </div>
  );
}

export function WhatIfTab({ w, names }: { readonly w: WhatIfDTO; readonly names: ReadonlyMap<string, string> }) {
  const [showAll, setShowAll] = useState(false);
  if (w.source === 'none' && w.rows.length === 0) return <p className="text-muted">No offer to project at this instant.</p>;
  const changed = w.rows.filter((r) => r.outcome !== 'unchanged');
  const same = w.rows.filter((r) => r.outcome === 'unchanged');
  const head =
    w.source === 'accepted'
      ? `Accepted by ${w.name ?? w.physicianId}: coverage effect recorded at acceptance`
      : w.source === 'proposed'
        ? `If ${w.name ?? w.physicianId} accepts the open offer`
        : `If ${w.name ?? w.physicianId} accepts the recommended offer`;
  return (
    <div className="space-y-2" data-testid="whatif" data-source={w.source}>
      <div className="flex items-center gap-2">
        <Chip tone={w.source === 'accepted' ? 'ok' : 'info'}>{w.source === 'accepted' ? 'ACCEPTED' : 'PROJECTED'}</Chip>
        <span className="text-[14px] font-semibold">{head}</span>
      </div>
      {w.window !== null && (
        <p className="text-[13px] text-muted">
          window <span className="num text-text">{etHm(w.window.startMs)}–{etHm(w.window.endMs)} ET</span> · routable at start:{' '}
          {w.routableAtStart.map((r) => (
            <span key={r.hospitalId} className="num mr-2 text-text">
              {shortName(names.get(r.hospitalId) ?? r.hospitalId)} {r.count}
            </span>
          ))}
          {w.filledNeedIds.length > 0 && <span className="text-ok">· {w.filledNeedIds.length} needs filled</span>}
        </p>
      )}
      {changed.map((r) => (
        <WhatIfRow key={r.needId} r={r} />
      ))}
      {same.length > 0 && (
        <button type="button" className="text-[13px] text-muted hover:text-text" onClick={() => setShowAll((s) => !s)}>
          {showAll ? '▾' : '▸'} {same.length} needs unchanged
        </button>
      )}
      {showAll && same.map((r) => <WhatIfRow key={r.needId} r={r} />)}
      {w.introduced.length > 0 && (
        <p className="text-[12px] text-warning">
          New after the offer: {w.introduced.map((n) => `${n.kind} ${n.hospitalId} ${etHm(n.startMs)}–${etEnd(n.endMs)}`).join('; ')}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ OFFERS

function OfferCard({ o, view }: { readonly o: OfferDTO; readonly view: ViewDTO }) {
  const { role, send } = useLive();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const actions = o.allowedActions[role] ?? [];
  const qr = view.qr?.[o.offerId];
  const names = o.hospitalNames.map(shortName).join(', ');
  return (
    <div data-testid="offer-card" data-offer-id={o.offerId} className="rounded-lg border border-border bg-raised/50 p-3">
      <div className="flex items-center gap-2">
        <StatusPill status={o.status} />
        <span className="text-[15px] font-semibold">{o.name}</span>
        <span className="num text-[12px] text-muted">{o.physicianId}</span>
        {o.status === 'delivered' && o.msUntilExpiry !== null && (
          <span className="ml-auto text-right">
            <span className="block text-[10px] uppercase tracking-wider text-muted">expires in</span>
            <span className="num text-[24px] font-semibold leading-none text-warning" data-testid="offer-countdown">
              {countdown(o.msUntilExpiry)}
            </span>
          </span>
        )}
      </div>
      <div className="mt-1.5 text-[13px] text-muted">
        <span className="num text-text">
          {etHm(o.window.startMs)}–{etHm(o.window.endMs)} ET
        </span>{' '}
        · {names} · seed <span className="num text-text">{o.seededConsultCount}</span> · via <span className="num">{o.channel}</span> · <span className="num">{o.offerId}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {o.needs.map((n) => (
          <span key={n.id} className="num rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">
            {n.kind} {n.hospitalId} {etHm(n.startMs)}–{etEnd(n.endMs)}
          </span>
        ))}
      </div>
      <div className="mt-1.5 text-[12px] text-muted">
        proposed {etHm(o.proposedAtMs)} by {o.proposedBy}
        {o.approvedAtMs !== null && (
          <>
            {' '}
            · approved {etHm(o.approvedAtMs)} by {o.approvedBy}
          </>
        )}
        {o.outcome !== null && (
          <>
            {' '}
            · <span className="text-text">{o.outcome.status}</span> {o.outcome.atMs !== null && etHm(o.outcome.atMs)} {o.outcome.detail !== o.outcome.status && `— ${o.outcome.detail}`}
          </>
        )}
      </div>
      {actions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {actions.includes('approveOffer') && (
            <Button testId="approve-offer" tone="ok" onClick={() => void send({ type: 'approveOffer', offerId: o.offerId }, { okText: `Approved and sent to ${o.name} (simulated ${o.channel})` })}>
              Approve &amp; send
            </Button>
          )}
          {actions.includes('rejectOffer') && !rejecting && (
            <Button tone="critical" onClick={() => setRejecting(true)}>
              Reject…
            </Button>
          )}
          {actions.includes('cancelOffer') && (
            <Button tone="muted" onClick={() => void send({ type: 'cancelOffer', offerId: o.offerId, reason: `cancelled by the ${role.replace('_', ' ')}` }, { okText: 'Offer cancelled' })}>
              Cancel offer
            </Button>
          )}
        </div>
      )}
      {rejecting && (
        <div className="mt-2 flex gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (logged in the audit)" className="flex-1 rounded-md border border-border bg-bg px-2 py-1 text-[14px]" />
          <Button tone="critical" disabled={reason.trim() === ''} onClick={() => void send({ type: 'rejectOffer', offerId: o.offerId, reason: reason.trim() }, { okText: 'Offer rejected' }).then(() => setRejecting(false))}>
            Reject
          </Button>
        </div>
      )}
      {o.status === 'delivered' && qr !== undefined && (
        <div className="mt-3 flex items-center gap-3 rounded-md border border-border bg-bg/60 p-2" data-testid="offer-qr">
          <div className="h-[112px] w-[112px] shrink-0 overflow-hidden rounded bg-text p-1 [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <div className="min-w-0 text-[12px] text-muted">
            <div className="mb-1 font-semibold uppercase tracking-wider text-text">Physician&apos;s phone</div>
            <a href={qr.url} target="_blank" rel="noreferrer" className="num break-all text-info underline" data-testid="offer-url">
              {qr.url}
            </a>
            <div className="mt-1">Scan to open the offer as {o.name}. Delivery is simulated.</div>
          </div>
        </div>
      )}
      <div className="mt-2 text-right">
        <Link href={`/audit/${encodeURIComponent(o.offerId)}`} className="text-[13px] text-info underline" data-testid="audit-link">
          Audit trail →
        </Link>
      </div>
    </div>
  );
}

export function OffersTab({ view }: { readonly view: ViewDTO }) {
  const offers = [...view.offers].reverse();
  return (
    <div className="space-y-2" data-testid="offers">
      {offers.length === 0 && <p className="text-muted">No offers yet. Propose the recommended split-shift offer above (coordinator).</p>}
      {offers.map((o) => (
        <OfferCard key={o.offerId} o={o} view={view} />
      ))}
      {view.escalations.length > 0 && (
        <div className="pt-2">
          <div className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-muted">Escalations</div>
          {view.escalations.map((e) => (
            <div key={e.escalationId} className="mb-1.5 rounded-md border border-border bg-raised/40 p-2 text-[13px]">
              <div className="flex items-center gap-2">
                {e.authorizedAtMs === null ? <Chip tone="warning">AWAITING LEAD</Chip> : <Chip tone="ok">AUTHORIZED</Chip>}
                <span className="font-semibold">{e.headline}</span>
              </div>
              <div className="mt-1 text-muted">
                raised {etHm(e.raisedAtMs)} by {e.raisedBy}: {e.reason}
                {e.authorizedAtMs !== null && ` · authorized ${etHm(e.authorizedAtMs)} by ${e.authorizedBy}${e.note === null ? '' : ` (${e.note})`}`}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="pt-1 text-right">
        <a href="/api/audit.csv" className="text-[13px] text-info underline">
          Download audit CSV
        </a>
      </div>
    </div>
  );
}
