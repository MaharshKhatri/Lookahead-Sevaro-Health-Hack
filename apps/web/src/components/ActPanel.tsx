'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { OfferDTO, RecStepDTO, ViewDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import { LedgerTab, OffersTab, TrapTab, WhatIfTab } from './ActTabs';
import { DetailColumn } from './DetailColumn';
import { Explain } from './Explain';
import { NextActions } from './NextActions';
import { StressPanel } from './StressPanel';
import { useLive } from './live';
import { Button, Chip, Panel, StatusPill, cx, shortName } from './ui';

/**
 * RIGHT "ACT": the engine's top-issue recommendation as a chain (reassign ->
 * escalate -> split-shift offer, brief "Recommend an intervention for the top
 * issue") with role-gated buttons (brief "Users and Decision Rights"), then
 * the LEDGER / TRAP / WHAT-IF / OFFERS tabs.
 */

const LIVE = ['proposed', 'approved', 'sent', 'delivered'];

function Step({ n, title, children, tone = 'muted', last = false }: { readonly n: number; readonly title: ReactNode; readonly children: ReactNode; readonly tone?: 'muted' | 'critical' | 'accent' | 'ok'; readonly last?: boolean }) {
  const ring = { muted: 'border-border text-muted', critical: 'border-critical text-critical', accent: 'border-accent text-accent', ok: 'border-ok text-ok' }[tone];
  return (
    <li className="relative flex gap-3 pb-3">
      {!last && <span className="absolute left-[13px] top-7 h-[calc(100%-1.25rem)] w-px bg-border" aria-hidden />}
      <span className={cx('num z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 bg-panel text-[13px] font-bold', ring)}>{n}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-tight">{title}</div>
        <div className="mt-1 text-[13px] leading-snug text-muted">{children}</div>
      </div>
    </li>
  );
}

function blockers(step: RecStepDTO | undefined): string[] {
  // The first why-line restates the consult; the rest name each blocking physician (engine text).
  return step === undefined ? [] : step.detail.slice(1);
}

function OfferStep({ view, live, onProposed }: { readonly view: ViewDTO; readonly live: OfferDTO | undefined; readonly onProposed: () => void }) {
  const { role, send } = useLive();
  const rec = view.recommendedOffer;
  if (live !== undefined) {
    return (
      <Step n={3} tone={live.status === 'accepted' ? 'ok' : 'accent'} last title={<>Split-shift offer · {live.name}</>}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={live.status} />
          <span className="num text-text">
            {etHm(live.window.startMs)}–{etHm(live.window.endMs)} ET
          </span>
          <span>scope {live.hospitalNames.map(shortName).join(', ')} · seed {live.seededConsultCount}</span>
        </div>
        {live.status === 'proposed' && <div className="mt-1">Waiting for the clinical lead to approve (brief: every offer is approved before it is sent).</div>}
        {live.status === 'delivered' && <div className="mt-1">Delivered (simulated {live.channel}); waiting for the physician. See OFFERS for the countdown and QR.</div>}
        {live.status === 'accepted' && live.outcome !== null && <div className="mt-1 text-ok">{live.outcome.detail}. Projected coverage updated (WHAT-IF).</div>}
      </Step>
    );
  }
  const next = view.nextOffer;
  if (next.escalationSuggested) {
    const last = next.spent.at(-1);
    return (
      <Step n={3} tone="critical" last title="Split-shift offer → no next eligible physician">
        <div data-testid="escalation-suggested">
          {last !== undefined && (
            <>
              {last.name}&apos;s offer was <span className="font-semibold text-text">{last.status}</span>; the engine does not re-offer them for the same need (OQ-43) and nobody else passes every rule.{' '}
            </>
          )}
          <span className="font-semibold text-warning">Escalation suggested:</span> keep it with the clinical lead (step 2).
        </div>
      </Step>
    );
  }
  if (rec === null || (next.physicianId !== null && next.physicianId !== rec.physicianId)) {
    return (
      <Step n={3} last title="Split-shift offer">
        {next.physicianId !== null && next.name !== null ? `Next candidate: ${next.name}; see LEDGER for the window.` : 'No off-shift physician passes every rule right now; see LEDGER for each exclusion. Keep the escalation with the clinical lead.'}
      </Step>
    );
  }
  const anyLive = view.offers.some((o) => LIVE.includes(o.status));
  const canPropose = role === 'coordinator' && !anyLive;
  return (
    <Step n={3} tone="accent" last title={<>Split-shift offer → {rec.name}</>}>
      <div className="space-y-1">
        <div>
          <span className="num font-semibold text-text">
            {etHm(rec.window.startMs)}–{etHm(rec.window.endMs)} ET
          </span>{' '}
          · {Math.round(rec.window.effectiveMinutes / 6) / 10} h after {rec.window.minutesToOnline} min to come online
        </div>
        <div>
          scope <span className="text-text">{rec.scopeNames.map(shortName).join(', ')}</span> · seeded at <span className="num text-text">{rec.seededConsultCount}</span> consults · value{' '}
          <span className="num text-text">{rec.value}</span>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Button
            testId="propose-offer"
            disabled={!canPropose}
            title={role !== 'coordinator' ? 'Only the operations coordinator proposes offers' : anyLive ? 'An offer is already open (sequential dispatch, OQ-37)' : 'Propose to the clinical lead for approval'}
            onClick={() =>
              void send({ type: 'proposeOffer', physicianId: rec.physicianId }, { okText: `Offer to ${rec.name} proposed; awaiting clinical lead approval` }).then((r) => {
                if (r.ok) onProposed();
              })
            }
          >
            Propose offer
          </Button>
          <span className="text-[12px]">→ clinical lead approves → physician accepts on phone</span>
        </div>
      </div>
    </Step>
  );
}

type Tab = 'ledger' | 'trap' | 'whatif' | 'offers';

export function ActPanel({ view }: { readonly view: ViewDTO }) {
  const { role, send } = useLive();
  const [tab, setTab] = useState<Tab>('ledger');
  const [stressOpen, setStressOpen] = useState(false);
  const closeStress = useCallback(() => setStressOpen(false), []);
  const rec = view.recommendation;
  const names = useMemo(() => new Map(view.coverage.rows.map((r) => [r.hospitalId, r.hospitalName])), [view.coverage.rows]);
  const reassign = rec?.steps.find((s) => s.kind === 'REASSIGN_CONSULT');
  const escalate = rec?.steps.find((s) => s.kind === 'ESCALATE_TO_CLINICAL_LEAD');
  const live = [...view.offers].reverse().find((o) => [...LIVE, 'accepted'].includes(o.status));
  const escalation = rec === null ? undefined : view.escalations.find((e) => e.subject.attentionItemId === rec.attentionItemId);
  const top = view.attention.find((a) => a.id === rec?.attentionItemId);
  const tabs: { id: Tab; label: string; badge?: string }[] = [
    { id: 'ledger', label: 'Ledger', badge: `${view.ledger.filter((l) => l.eligible).length}/${view.ledger.length}` },
    { id: 'trap', label: 'Trap' },
    { id: 'whatif', label: 'What-if' },
    { id: 'offers', label: 'Offers', ...(view.offers.length > 0 ? { badge: String(view.offers.length) } : {}) },
  ];

  return (
    <Panel
      testId="panel-act"
      className="h-full"
      title="ACT"
      right={
        <>
          <span className="text-[12px] text-muted">acting as {role === 'coordinator' ? 'Coordinator' : 'Clinical lead'}</span>
          <Button size="sm" tone="muted" testId="stress-open" title="Open the stress test panel (prove it / break it)" onClick={() => setStressOpen((o) => !o)}>
            Stress test
          </Button>
        </>
      }
    >
      <StressPanel open={stressOpen} onClose={closeStress} />
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        <DetailColumn view={view} />
        <NextActions view={view} />
        <div className="border-b border-border p-4" data-testid="recommendation">
          <div className="mb-1 flex items-center gap-2">
            <Chip tone="accent">RECOMMENDATION</Chip>
            <span className="text-[12px] text-muted">for issue #{top?.rank ?? 1}</span>
          </div>
          {rec === null ? (
            <p className="text-muted">Nothing to recommend at this instant.</p>
          ) : (
            <>
              <h3 className="mb-2 text-[17px] font-semibold leading-snug">{rec.headline}</h3>
              <Explain kind="recommendation" id={rec.attentionItemId} className="mb-3" />
              <ol>
                <Step n={1} tone={reassign !== undefined && reassign.candidates.length === 0 ? 'critical' : 'accent'} title={reassign === undefined ? 'Reassign' : reassign.candidates.length === 0 ? 'Reassign → no routable candidate' : `Reassign → ${reassign.candidates[0]?.physicianId}`}>
                  {reassign === undefined ? (
                    'Not applicable to this issue.'
                  ) : reassign.candidates.length === 0 ? (
                    <ul className="space-y-0.5">
                      {blockers(reassign).map((b) => (
                        <li key={b}>· {b}</li>
                      ))}
                    </ul>
                  ) : (
                    <>
                      {reassign.candidates[0]?.why}
                      <div className="mt-1">
                        <Button size="sm" disabled={role !== 'coordinator'} onClick={() => void send({ type: 'requestReassignment', consultId: reassign.consultIds[0], toPhysicianId: reassign.candidates[0]?.physicianId }, { okText: 'Reassignment requested in Synapse' })}>
                          Request reassignment
                        </Button>
                      </div>
                    </>
                  )}
                </Step>
                <Step n={2} tone={escalation?.authorizedAtMs !== null && escalation !== undefined ? 'ok' : view.nextOffer.escalationSuggested ? 'critical' : 'accent'} title={view.nextOffer.escalationSuggested && escalation === undefined ? 'Escalate to the clinical lead (suggested)' : 'Escalate to the clinical lead'}>
                  <div>{escalate?.summary ?? 'The clinical lead authorizes escalations and approves split-shift offers.'}</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    {escalation === undefined ? (
                      <Button
                        size="sm"
                        tone={view.nextOffer.escalationSuggested ? 'accent' : 'muted'}
                        testId="raise-escalation"
                        disabled={role !== 'coordinator'}
                        title={role !== 'coordinator' ? 'The coordinator raises escalations' : 'Raise to the clinical lead on duty'}
                        onClick={() =>
                          void send(
                            {
                              type: 'raiseEscalation',
                              subject: { attentionItemId: rec.attentionItemId, consultIds: top?.consultIds ?? [], hospitalIds: top?.hospitalIds ?? [] },
                              reason: reassign !== undefined && reassign.candidates.length === 0 ? 'no routable candidate; split-shift offer recommended' : 'top issue needs the clinical lead',
                            },
                            { okText: 'Escalation raised to the clinical lead' },
                          )
                        }
                      >
                        Raise escalation
                      </Button>
                    ) : escalation.authorizedAtMs === null ? (
                      <Chip tone="warning">RAISED {etHm(escalation.raisedAtMs)} · AWAITING LEAD</Chip>
                    ) : (
                      <Chip tone="ok">AUTHORIZED {etHm(escalation.authorizedAtMs)}</Chip>
                    )}
                  </div>
                </Step>
                <OfferStep view={view} live={live} onProposed={() => setTab('offers')} />
              </ol>
            </>
          )}
        </div>

        <div className="sticky top-0 z-10 flex border-b border-border bg-panel px-2" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-testid={`tab-${t.id}`}
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cx('flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-semibold uppercase tracking-wider', tab === t.id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')}
            >
              {t.label}
              {t.badge !== undefined && <span className="num rounded bg-raised px-1 text-[11px] text-muted">{t.badge}</span>}
            </button>
          ))}
        </div>
        <div className="p-3">
          {tab === 'ledger' && <LedgerTab rows={view.ledger} />}
          {tab === 'trap' && <TrapTab trap={view.offerContext.trap} names={names} />}
          {tab === 'whatif' && <WhatIfTab w={view.offerContext.whatIf} names={names} />}
          {tab === 'offers' && <OffersTab view={view} />}
        </div>
      </div>
    </Panel>
  );
}
