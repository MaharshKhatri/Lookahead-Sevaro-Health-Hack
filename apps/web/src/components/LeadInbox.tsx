'use client';

import { useState, type ReactNode } from 'react';
import type { EscalationDTO, OfferDTO, ViewDTO, WhatIfRowDTO } from '@/lib/dto';
import { etEnd, etHm, etHms } from '@/lib/format';
import { LiveProvider, useLive } from './live';
import { Button, Chip, StatusPill, Toasts, cx, shortName } from './ui';

/**
 * /lead: the clinical lead's phone inbox (brief "Users and Decision Rights":
 * the clinical lead "Approve[s] or reject[s] split-shift offers; authorize[s]
 * escalations" and needs "proposed interventions with rationale"). Everything
 * shown is engine output from /api/view; the lead acts with role clinical_lead.
 */

const RULE_PLAIN: Readonly<Record<string, string>> = {
  ELIG_OPT_IN: 'has not opted in to split shifts',
  ELIG_CREDENTIALED_AT_GAP: 'not credentialed at any gap hospital',
  ELIG_REST_10H: 'would have under 10 h rest',
  ELIG_HOURS_60: 'would exceed 60 h in 7 days',
  ELIG_NO_SCHEDULE_OVERLAP: 'would overlap a shift already scheduled',
  ELIG_MIN_OFFER_2H: 'offer would be under 2 hours',
  SAFETY_ONE_OPEN_OFFER: 'already has an open offer',
  SAFETY_THREE_OFFERS_PER_WEEK: 'already had 3 offers this week',
};

const NEED_PLAIN: Readonly<Record<string, string>> = { DEADLOCK_NOW: 'no routable physician', HARD_GAP: 'hard coverage gap', AT_RISK: 'covered only by an unconfirmed arrival' };

function effectLine(r: WhatIfRowDTO): string {
  const where = `${shortName(r.hospitalName)} ${NEED_PLAIN[r.kind] ?? r.kind} (${etHm(r.startMs)}–${etEnd(r.endMs)})`;
  if (r.outcome === 'closed') return `${where}: closed`;
  if (r.outcome === 'downgraded') return `${where}: downgraded to covered-if-the-physician-shows-up`;
  if (r.outcome === 'shortened') return `${where}: ${r.beforeMinutes} → ${r.remainingMinutes ?? '?'} min`;
  return `${where}: unchanged`;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="mt-3">
      <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-muted">{title}</h4>
      <div className="text-[15px] leading-snug">{children}</div>
    </section>
  );
}

function OfferApproval({ o, view }: { readonly o: OfferDTO; readonly view: ViewDTO }) {
  const { send } = useLive();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const excluded = o.ledger.filter((l) => !l.eligible);
  const me = o.ledger.find((l) => l.physicianId === o.physicianId);
  const ctx = view.offerContext.offerId === o.offerId ? view.offerContext : null;
  const effects = ctx?.whatIf.rows.filter((r) => r.outcome !== 'unchanged') ?? [];
  const top = view.recommendation;
  return (
    <article data-testid="lead-offer" data-offer-id={o.offerId} className="rounded-2xl border border-accent/60 bg-panel p-4">
      <div className="flex items-center gap-2">
        <Chip tone="accent">APPROVAL NEEDED</Chip>
        <span className="num ml-auto text-[13px] text-muted">proposed {etHm(o.proposedAtMs)}</span>
      </div>
      <h3 className="mt-2 text-[22px] font-semibold leading-tight">Split-shift offer to {o.name}</h3>
      <div className="num mt-1 text-[16px] text-text">
        {etHm(o.window.startMs)}–{etHm(o.window.endMs)} ET · {Math.round(o.window.effectiveMinutes / 6) / 10} h
      </div>
      <div className="text-[14px] text-muted">{o.hospitalNames.join(', ')}</div>

      {top !== null && (
        <Section title="Top issue">
          {top.headline}
          <ul className="mt-1 space-y-0.5 text-[14px] text-muted">
            {o.needs.map((n) => (
              <li key={n.id}>
                · {shortName(n.hospitalName)}: {NEED_PLAIN[n.kind] ?? n.kind} {etHm(n.startMs)}–{etEnd(n.endMs)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Why this physician">
        {me?.eligible === true ? `The only one of ${o.ledger.length} off-shift physicians who passes every rule` : 'Eligible at proposal time'}
        {me !== undefined && me.rank !== null && ` (rank ${me.rank})`}.
        <ul className="mt-1 space-y-0.5 text-[14px] text-muted">
          {excluded.map((l) => (
            <li key={l.physicianId}>
              · {l.name}: {l.failedRules.map((r) => RULE_PLAIN[r] ?? r).join('; ')}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Split-shift trap mitigation">
        Routing limited to {o.hospitalNames.map(shortName).join(', ')} and started at {o.seededConsultCount} consults, so the joiner is not sent every call at every hospital.
        <ul className="mt-1 space-y-0.5 text-[13px] text-muted">
          {o.trapWhy.slice(-2).map((w) => (
            <li key={w}>· {w}</li>
          ))}
        </ul>
      </Section>

      {effects.length > 0 && (
        <Section title="If they accept">
          <ul className="space-y-0.5" data-testid="lead-effects">
            {effects.map((r) => (
              <li key={r.needId}>· {effectLine(r)}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Message the physician will receive">
        <pre className="num whitespace-pre-wrap rounded-lg border border-border bg-bg p-2.5 text-[13px] text-text/90">{o.message}</pre>
      </Section>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Button size="lg" tone="ok" testId="lead-approve" onClick={() => void send({ type: 'approveOffer', offerId: o.offerId }, { okText: `Approved: sent to ${o.name} (simulated ${o.channel})` })}>
          Approve
        </Button>
        <Button size="lg" tone="critical" testId="lead-reject-open" onClick={() => setRejecting((r) => !r)}>
          Reject…
        </Button>
      </div>
      {rejecting && (
        <div className="mt-3 space-y-2">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Reason (required, kept in the audit)" className="w-full rounded-lg border border-border bg-bg p-2 text-[16px]" data-testid="lead-reject-reason" />
          <Button size="lg" tone="critical" className="w-full" disabled={reason.trim() === ''} testId="lead-reject" onClick={() => void send({ type: 'rejectOffer', offerId: o.offerId, reason: reason.trim() }, { okText: 'Offer rejected' })}>
            Reject with reason
          </Button>
        </div>
      )}
    </article>
  );
}

function EscalationCard({ e }: { readonly e: EscalationDTO }) {
  const { send } = useLive();
  const [note, setNote] = useState('');
  return (
    <article data-testid="lead-escalation" className="rounded-2xl border border-warning/60 bg-panel p-4">
      <div className="flex items-center gap-2">
        <Chip tone="warning">ESCALATION</Chip>
        <span className="num ml-auto text-[13px] text-muted">raised {etHm(e.raisedAtMs)}</span>
      </div>
      <h3 className="mt-2 text-[19px] font-semibold leading-snug">{e.headline}</h3>
      <p className="mt-1 text-[15px] text-muted">{e.reason}</p>
      <input value={note} onChange={(x) => setNote(x.target.value)} placeholder="Note (optional), e.g. physician-to-physician handoff" className="mt-3 w-full rounded-lg border border-border bg-bg p-2 text-[16px]" />
      <Button size="lg" tone="ok" className="mt-3 w-full" testId="lead-authorize" onClick={() => void send({ type: 'authorizeEscalation', escalationId: e.escalationId, ...(note.trim() === '' ? {} : { note: note.trim() }) }, { okText: 'Escalation authorized' })}>
        Authorize escalation
      </Button>
    </article>
  );
}

function Inbox() {
  const { view, sse, toasts, dismiss } = useLive();
  if (view === null) return <p className="p-6 text-muted">Loading…</p>;
  const pending = view.offers.filter((o) => o.status === 'proposed');
  const escalations = view.escalations.filter((e) => e.authorizedAtMs === null);
  const recent = [...view.offers].reverse().filter((o) => o.status !== 'proposed');
  return (
    <div className="mx-auto min-h-screen max-w-[520px] px-4 pb-10 pt-4">
      <header className="mb-4 flex items-center gap-3">
        <div>
          <div className="text-[13px] font-semibold uppercase tracking-wider text-accent">Clinical lead on duty</div>
          <div className="text-[24px] font-bold">Inbox</div>
        </div>
        <div className="ml-auto text-right">
          <div className="num text-[20px] font-semibold">{etHms(view.clock.nowMs)} ET</div>
          <div className={cx('text-[12px]', sse === 'open' ? 'text-ok' : 'text-warning')}>● {sse === 'open' ? 'live' : sse}</div>
        </div>
      </header>
      <div className="space-y-4">
        {pending.map((o) => (
          <OfferApproval key={o.offerId} o={o} view={view} />
        ))}
        {escalations.map((e) => (
          <EscalationCard key={e.escalationId} e={e} />
        ))}
        {pending.length === 0 && escalations.length === 0 && (
          <div className="rounded-2xl border border-border bg-panel p-6 text-center text-muted" data-testid="lead-empty">
            Nothing waiting for you.
          </div>
        )}
        {recent.length > 0 && (
          <section>
            <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Recent offers</h4>
            {recent.map((o) => (
              <div key={o.offerId} className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-panel px-3 py-2.5">
                <StatusPill status={o.status} />
                <span className="text-[15px]">{o.name}</span>
                <span className="num ml-auto text-[13px] text-muted">
                  {etHm(o.window.startMs)}–{etHm(o.window.endMs)}
                </span>
              </div>
            ))}
          </section>
        )}
      </div>
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

export function LeadInbox({ initial }: { readonly initial: ViewDTO | null }) {
  return (
    <LiveProvider initial={initial} fixedRole="clinical_lead">
      <Inbox />
    </LiveProvider>
  );
}
