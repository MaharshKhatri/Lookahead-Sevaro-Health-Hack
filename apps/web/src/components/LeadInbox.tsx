'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { EscalationDTO, OfferDTO, StandbyDTO, ViewDTO, WhatIfRowDTO } from '@/lib/dto';
import { etEnd, etHm, etHms } from '@/lib/format';
import { Explain } from './Explain';
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

      <Section title="Briefing">
        <Explain kind="lead_briefing" id={o.offerId} auto />
      </Section>

      <Section title="Message the physician will receive">
        <pre className="num whitespace-pre-wrap rounded-lg border border-border bg-bg p-2.5 text-[13px] text-text/90">{o.message}</pre>
      </Section>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <ConfirmSend testId="lead-approve" label="Approve" to={o.name} message={o.message} onConfirm={() => void send({ type: 'approveOffer', offerId: o.offerId }, { okText: `Approved: sent to ${o.name} (simulated ${o.channel})` })} />
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

/**
 * Approve -> confirm (UI pass): the clinical lead sees the exact text that will
 * be sent before it goes out. The confirm button takes focus, so Enter sends and
 * Esc or Cancel goes back. Nothing is sent until "Confirm and send".
 */
function ConfirmSend({ testId, label, to, message, onConfirm }: { readonly testId: string; readonly label: string; readonly to: string; readonly message: string; readonly onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button size="lg" tone="accent" testId={testId} confirmTrigger onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  return (
    <div className="col-span-2 space-y-2 rounded-[2px] border border-accent bg-bg p-3" data-testid={`${testId}-panel`} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <p className="text-[15px] font-semibold text-text">Send this exact message to {to}?</p>
      <pre className="num whitespace-pre-wrap text-[13px] text-text/90" data-testid={`${testId}-message`}>
        {message}
      </pre>
      <p className="text-[13px] text-muted">No case information is included.</p>
      <div className="grid grid-cols-2 gap-2">
        <Button
          size="lg"
          tone="accent"
          testId={`${testId}-confirm`}
          autoFocus
          onClick={() => {
            setOpen(false);
            onConfirm();
          }}
        >
          Confirm and send
        </Button>
        <Button size="lg" tone="muted" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Standby approvals (Phase 4/7, D-90): the pre-alert, the activation and the release each need the clinical lead. */
function StandbyApproval({ s }: { readonly s: StandbyDTO }) {
  const { send } = useLive();
  const [reason, setReason] = useState('');
  const stage = s.status === 'proposed' ? 'prealert' : s.status === 'activation_proposed' ? 'activation' : s.status === 'acknowledged' ? 'release' : null;
  if (stage === null) return null;
  const title = stage === 'prealert' ? `Standby pre-alert to ${s.name}` : stage === 'activation' ? `Activate standby: ${s.name}` : `Release standby: ${s.name}`;
  const text = stage === 'prealert' ? s.message : stage === 'activation' ? (s.activation?.message ?? '') : `Stand-down ${s.standDownRecommended ? 'recommended (risk faded at two consecutive checks)' : 'available (risk still present; the lead decides)'}.`;
  return (
    <article data-testid="lead-standby" data-standby-id={s.standbyId} data-stage={stage} className="rounded-2xl border border-info/60 bg-panel p-4">
      <div className="flex items-center gap-2">
        <Chip tone={stage === 'release' ? 'muted' : 'info'}>{stage === 'release' ? 'RELEASE' : 'APPROVAL NEEDED'}</Chip>
        <Chip tone="accent">STANDBY</Chip>
        <span className="num ml-auto text-[13px] text-muted">{etHm(s.proposedAtMs)}</span>
      </div>
      <h3 className="mt-2 text-[22px] font-semibold leading-tight">{title}</h3>
      <div className="num mt-1 text-[16px] text-text">
        {etHm(s.window.startMs)}–{etHm(s.window.endMs)} ET · covers {s.hospitalNames.map(shortName).join(', ')}
      </div>
      <div className="text-[14px] text-muted">
        P(accept) {s.pAccept} · {s.valueEUM} weighted uncovered minutes avoided · false-alarm chance {s.falseAlarmChance}
      </div>
      {stage === 'activation' && s.activation !== null && (
        <Section title="Why now">
          {s.activation.trigger.detail}
          <div className="mt-1 text-[13px] text-muted">log on by {etHm(s.activation.logOnByMs)} ET · scope {s.activation.scopeHospitalIds.join(', ')} · seeded at {s.activation.seededConsultCount} consults (split-shift trap)</div>
        </Section>
      )}
      <Section title={stage === 'release' ? 'Status' : 'Message to the physician (hospitals, hours and start time only)'}>
        <pre className="whitespace-pre-wrap font-sans text-[15px]">{text}</pre>
      </Section>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {stage === 'prealert' && (
          <>
            <ConfirmSend testId="lead-approve-standby" label="Approve pre-alert" to={s.name} message={text} onConfirm={() => void send({ type: 'approveStandby', standbyId: s.standbyId }, { okText: `Pre-alert sent to ${s.name} (simulated ${s.channel})` })} />
            <Button size="lg" tone="critical" testId="lead-reject-standby" onClick={() => void send({ type: 'rejectStandby', standbyId: s.standbyId, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) }, { okText: 'Pre-alert rejected' })}>
              Reject
            </Button>
          </>
        )}
        {stage === 'activation' && (
          <>
            <ConfirmSend testId="lead-approve-activation" label="Approve activation" to={s.name} message={text} onConfirm={() => void send({ type: 'approveActivation', standbyId: s.standbyId }, { okText: `Activation sent to ${s.name}` })} />
            <Button size="lg" tone="critical" testId="lead-reject-activation" onClick={() => void send({ type: 'rejectActivation', standbyId: s.standbyId, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) }, { okText: 'Activation rejected' })}>
              Reject
            </Button>
          </>
        )}
        {stage === 'release' && (
          <Button size="lg" tone={s.standDownRecommended ? 'ok' : 'muted'} className="col-span-2" testId="lead-release-standby" onClick={() => void send({ type: 'releaseStandby', standbyId: s.standbyId, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) }, { okText: `${s.name} released` })}>
            Release standby
          </Button>
        )}
      </div>
      {stage !== 'release' && <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason if rejecting (kept in the audit)" className="mt-2 w-full rounded-lg border border-border bg-bg p-2 text-[15px]" data-testid="lead-standby-reason" />}
    </article>
  );
}

function Inbox() {
  const { view, sse, toasts, dismiss, send } = useLive();
  // Keyboard: A approves the first item waiting (offer, standby pre-alert or activation), unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view === null || (e.key !== 'a' && e.key !== 'A') || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      // A opens the first pending confirmation (the exact message); Enter on the focused "Confirm and send" sends it.
      const trigger = document.querySelector<HTMLButtonElement>('[data-confirm-trigger="true"]');
      if (trigger !== null) {
        e.preventDefault();
        trigger.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, send]);
  if (view === null) return <p className="p-6 text-muted">Loading…</p>;
  const pending = view.offers.filter((o) => o.status === 'proposed');
  const escalations = view.escalations.filter((e) => e.authorizedAtMs === null);
  const standbys = (view.standby?.standbys ?? []).filter((s) => s.status === 'proposed' || s.status === 'activation_proposed' || (s.status === 'acknowledged' && s.standDownRecommended));
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
        {standbys.map((s) => (
          <StandbyApproval key={s.standbyId} s={s} />
        ))}
        {escalations.map((e) => (
          <EscalationCard key={e.escalationId} e={e} />
        ))}
        {pending.length === 0 && escalations.length === 0 && standbys.length === 0 && (
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
