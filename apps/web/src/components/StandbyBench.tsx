'use client';

import { useState } from 'react';
import type { StandbyDTO, StandbyPlanDTO, ViewDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import { DeltaChip } from './DeltaChip';
import { useLive } from './live';
import { Button, Chip, cx, shortName } from './ui';
import type { Delta } from './useDelta';

/**
 * STANDBY BENCH (Phase 7, D-90): the engine's greedy selection as cards with
 * the live standby (if any) and role-gated actions (coordinator pre-alerts and
 * proposes activation; the clinical lead approves, rejects, releases; the
 * physician answers on the phone), the collapsed candidate ledger with each
 * failing rule, and an explicit empty-bench state per high-risk hospital.
 */

const STATUS_WORD: Readonly<Record<string, string>> = {
  proposed: 'Awaiting approval',
  approved: 'Approved',
  prealert_sent: 'Pre-alert sent',
  prealert_delivered: 'Pre-alert sent',
  acknowledged: 'Acknowledged',
  declined: 'Declined',
  rejected: 'Rejected',
  expired: 'Expired',
  cancelled: 'Cancelled',
  activation_proposed: 'Activation awaiting approval',
  activation_approved: 'Activation approved',
  activation_sent: 'Activation sent',
  activation_delivered: 'Activation sent',
  activated: 'Active',
  activation_declined: 'Activation declined',
  released: 'Released',
  candidate: 'Proposed by the engine',
};

/** Shape per state (never color alone, UI pass): ring = waiting on a person, dot = sent, bar = act now, square = settled, cross = ended. */
const statusShape = (s: string): 'ring' | 'dot' | 'bar' | 'square' | 'cross' =>
  s === 'proposed' || s === 'activation_proposed' || s === 'candidate' ? 'ring' : s === 'activation_recommended' ? 'bar' : s === 'activated' || s === 'released' || s === 'acknowledged' ? 'square' : ['declined', 'rejected', 'expired', 'cancelled', 'activation_declined'].includes(s) ? 'cross' : 'dot';

function initials(name: string): string {
  const parts = name.replace(/^Dr\.?\s+/i, '').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
}

const statusTone = (s: string): 'ok' | 'warning' | 'critical' | 'info' | 'muted' =>
  s === 'activated' ? 'ok' : s === 'acknowledged' ? 'ok' : s.endsWith('delivered') ? 'warning' : s === 'expired' || s === 'rejected' ? 'critical' : s === 'declined' || s === 'released' || s === 'cancelled' || s === 'activation_declined' ? 'muted' : 'info';

export function StandbyStatusChip({ status, recommended = false }: { readonly status: string; readonly recommended?: boolean }) {
  const shown = recommended && status === 'acknowledged' ? 'activation_recommended' : status;
  const tone = shown === 'activation_recommended' ? 'warning' : statusTone(status);
  const color = `var(--color-${tone === 'muted' ? 'muted' : tone})`;
  const shape = statusShape(shown);
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-[2px] border px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide', tone === 'muted' ? 'border-border text-muted' : `border-${tone}/60 text-${tone}`)}>
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
        {shape === 'dot' && <circle cx="4" cy="4" r="3.2" fill={color} />}
        {shape === 'ring' && <circle cx="4" cy="4" r="3" fill="none" stroke={color} strokeWidth="1.4" />}
        {shape === 'square' && <rect x="0.8" y="0.8" width="6.4" height="6.4" fill={color} />}
        {shape === 'bar' && <rect x="0.5" y="2.5" width="7" height="3" fill={color} />}
        {shape === 'cross' && <path d="M1 1 L7 7 M7 1 L1 7" stroke={color} strokeWidth="1.5" />}
      </svg>
      <span data-testid="standby-status">{shown === 'activation_recommended' ? 'Activation recommended' : (STATUS_WORD[status] ?? status.replace(/_/g, ' '))}</span>
    </span>
  );
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const LIVE = ['proposed', 'approved', 'prealert_sent', 'prealert_delivered', 'acknowledged', 'activation_proposed', 'activation_approved', 'activation_sent', 'activation_delivered', 'activation_declined', 'activated'];

function Card({ sel, live, plan, names }: { readonly sel: StandbyPlanDTO['selected'][number] | null; readonly live: StandbyDTO | null; readonly plan: StandbyPlanDTO; readonly names: ReadonlyMap<string, string> }) {
  const { role, send } = useLive();
  const [reason, setReason] = useState('');
  const physicianId = live?.physicianId ?? sel?.physicianId ?? '';
  const name = live?.name ?? sel?.name ?? physicianId;
  const window = live?.window ?? sel?.window ?? null;
  const hospitals = live?.coveredHospitalIds ?? sel?.coveredHospitals ?? [];
  const pAccept = live?.pAccept ?? sel?.pAccept ?? 0;
  const value = live?.valueEUM ?? sel?.valueEUM ?? 0;
  const falseAlarm = live?.falseAlarmChance ?? sel?.falseAlarmChance ?? 0;
  const status = live?.status ?? null;
  const allowed = live?.allowedActions ?? {};
  const can = (r: 'coordinator' | 'clinical_lead', a: string) => role === r && (allowed[r] ?? []).includes(a);
  const anyLive = live !== null && LIVE.includes(live.status);
  const okText = (t: string) => ({ okText: t });
  return (
    <article data-testid="bench-card" data-physician-id={physicianId} data-status={status ?? 'candidate'} className={cx('rounded-[2px] border border-l-2 bg-panel p-2.5', status === 'activated' ? 'border-border border-l-ok' : anyLive ? 'border-border border-l-accent' : 'border-border border-l-border')}>
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className="num inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[2px] border border-border bg-raised text-[11px] font-semibold text-text">
          {initials(name)}
        </span>
        <span className="text-[15px] font-semibold">{name}</span>
        <span className="num text-[11px] text-muted">{physicianId}</span>
        {sel !== null && <span className="text-[11px] uppercase tracking-wide text-muted">round {sel.round}</span>}
        {status !== null ? <StandbyStatusChip status={status} recommended={live?.activationRecommended != null} /> : <StandbyStatusChip status="candidate" />}
        {live?.msUntilExpiry !== null && live?.msUntilExpiry !== undefined && <span className="num text-[12px] text-warning">expires {etHm(live.prealertExpiresAtMs ?? 0)}</span>}
      </div>
      <div className="num mt-1 text-[13px] text-text">
        {window !== null ? `${etHm(window.startMs)}–${etHm(window.endMs)} ET` : '–'} <span className="text-muted">· {hospitals.map((h) => shortName(names.get(h) ?? h)).join(', ') || 'no covered hospital'}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-muted">
        <span title="pAccept = 0.8 / (1 + 0.25 x declines in 30 d), illustrative (policy)">
          P(accept) <span className="num text-text">{pct(pAccept)}</span>
        </span>
        <span title="Expected stroke-weighted uncovered minutes avoided (D-90 4.3)">
          <span className="num text-text" data-testid="bench-eum">{value}</span> expected uncovered minutes avoided
        </span>
        <span title="1 − max covered P(gap): the chance this physician is called in for nothing">
          false alarm <span className="num text-text">{pct(falseAlarm)}</span>
        </span>
        {live?.minutesToOnline !== undefined && (
          <span>
            online in <span className="num text-text">{live.minutesToOnline} min</span>
          </span>
        )}
      </div>
      {live?.activationRecommended && (
        <div className="mt-1.5 rounded border border-critical/60 bg-critical/10 px-2 py-1 text-[12px] text-critical" data-testid="activation-recommended">
          <span className="font-semibold uppercase">Activation recommended</span> · {live.activationRecommended.detail}
        </div>
      )}
      {live !== null && live.status === 'acknowledged' && live.standDownRecommended && (
        <div className="mt-1.5 rounded border border-info/60 bg-info/10 px-2 py-1 text-[12px] text-info" data-testid="standdown-recommended">
          <span className="font-semibold uppercase">Stand-down recommended</span> · quiet now and 5 min ago (OQ-51)
        </div>
      )}
      {live?.activation && (
        <div className="mt-1.5 text-[12px] text-muted">
          activation ({live.activation.trigger.kind}): log on by <span className="num text-text">{etHm(live.activation.logOnByMs)}</span> until <span className="num text-text">{etHm(live.activation.endMs)}</span> · scope {live.activation.scopeHospitalIds.map((h) => shortName(names.get(h) ?? h)).join(', ')} · seed {live.activation.seededConsultCount}
          {live.activation.effectiveStartMs !== null && <> · online from {etHm(live.activation.effectiveStartMs)}</>}
        </div>
      )}
      {live?.outcome && <div className="mt-1 text-[12px] text-muted">{live.outcome.detail}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {live === null && sel !== null && (
          <Button size="sm" testId="bench-prealert" disabled={role !== 'coordinator'} title={role !== 'coordinator' ? 'The coordinator proposes pre-alerts' : 'Propose this pre-alert to the clinical lead'} onClick={() => void send({ type: 'proposeStandby', physicianId }, okText(`Pre-alert to ${name} proposed; awaiting clinical lead approval`))}>
            Pre-alert
          </Button>
        )}
        {can('clinical_lead', 'approveStandby') && (
          <Button size="sm" tone="ok" testId="bench-approve-standby" onClick={() => void send({ type: 'approveStandby', standbyId: live!.standbyId }, okText(`Pre-alert sent to ${name} (simulated ${live!.channel})`))}>
            Approve pre-alert
          </Button>
        )}
        {can('clinical_lead', 'rejectStandby') && (
          <Button size="sm" tone="critical" testId="bench-reject-standby" onClick={() => void send({ type: 'rejectStandby', standbyId: live!.standbyId, reason: reason.trim() || 'rejected by the clinical lead' }, okText('Pre-alert rejected'))}>
            Reject
          </Button>
        )}
        {can('coordinator', 'proposeActivation') && (
          <Button size="sm" testId="bench-propose-activation" onClick={() => void send({ type: 'proposeActivation', standbyId: live!.standbyId }, okText(`Activation of ${name} proposed; awaiting clinical lead approval`))}>
            Propose activation
          </Button>
        )}
        {can('clinical_lead', 'approveActivation') && (
          <Button size="sm" tone="ok" testId="bench-approve-activation" onClick={() => void send({ type: 'approveActivation', standbyId: live!.standbyId }, okText(`Activation sent to ${name}`))}>
            Approve activation
          </Button>
        )}
        {can('clinical_lead', 'rejectActivation') && (
          <Button size="sm" tone="critical" onClick={() => void send({ type: 'rejectActivation', standbyId: live!.standbyId, reason: reason.trim() || 'not now' }, okText('Activation rejected; standby stays acknowledged'))}>
            Reject activation
          </Button>
        )}
        {can('clinical_lead', 'releaseStandby') && (
          <Button size="sm" tone={live!.standDownRecommended ? 'accent' : 'muted'} testId="bench-release" onClick={() => void send({ type: 'releaseStandby', standbyId: live!.standbyId, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) }, okText(`${name} released`))}>
            Release
          </Button>
        )}
        {(can('clinical_lead', 'rejectStandby') || can('clinical_lead', 'releaseStandby') || can('clinical_lead', 'rejectActivation')) && (
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (kept in the audit)" className="min-w-[140px] flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px]" aria-label="Reason" />
        )}
        {live !== null && live.status !== 'proposed' && (
          <a href={live.standbyPath} target="_blank" rel="noreferrer" className="num ml-auto text-[11px] text-info underline" data-testid="standby-link">
            phone view
          </a>
        )}
        {live === null && sel === null && <span className="text-[12px] text-muted">not in the current plan</span>}
      </div>
      {sel !== null && live === null && (
        <details className="mt-1 text-[11px] text-muted">
          <summary className="cursor-pointer">why selected</summary>
          <ul className="mt-0.5 space-y-0.5">
            {sel.why.map((w) => (
              <li key={w}>· {w}</li>
            ))}
          </ul>
        </details>
      )}
      {plan.selected.length === 0 && sel === null && live === null && null}
    </article>
  );
}

export function StandbyBench({ view, deltas }: { readonly view: ViewDTO; readonly deltas: ReadonlyMap<string, Delta> }) {
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const sb = view.standby;
  if (sb === undefined) return <p className="p-3 text-muted">Standby plan not available in this view.</p>;
  const plan = sb.plan;
  const names = new Map(view.coverage.rows.map((r) => [r.hospitalId, r.hospitalName]));
  const latestByPhysician = new Map<string, StandbyDTO>();
  for (const s of sb.standbys) latestByPhysician.set(s.physicianId, s);
  const cards: { key: string; sel: StandbyPlanDTO['selected'][number] | null; live: StandbyDTO | null }[] = [];
  for (const s of [...sb.standbys].reverse()) if (latestByPhysician.get(s.physicianId) === s) cards.push({ key: s.standbyId, sel: plan.selected.find((x) => x.physicianId === s.physicianId) ?? null, live: s });
  for (const s of plan.selected) if (!latestByPhysician.has(s.physicianId)) cards.push({ key: `sel-${s.physicianId}`, sel: s, live: null });
  const t = plan.totals;
  return (
    <div data-testid="standby-bench" className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
        <span title={plan.why.join('\n')}>
          expected uncovered min (stroke-weighted) <span className="num text-text" data-testid="eum-weighted">{t.totalWeightedEUM}</span> <DeltaChip d={deltas.get('eum:weighted')} digits={1} />
        </span>
        <span>
          avoided by the bench <span className="num text-ok">{t.expectedEUMAvoided}</span> <DeltaChip d={deltas.get('eum:avoided')} digits={1} />
        </span>
        <span>
          residual <span className="num text-warning">{t.residualEUM}</span> <DeltaChip d={deltas.get('eum:residual')} digits={1} />
        </span>
        {t.falseAlarmChance !== null && (
          <span>
            false-alarm chance <span className="num text-text">{pct(t.falseAlarmChance)}</span>
          </span>
        )}
        <span className="num ml-auto">horizon to {etHm(plan.horizonEndMs)} ET</span>
      </div>
      {cards.length === 0 && (
        <p className="rounded-lg border border-border p-3 text-[13px] text-muted" data-testid="bench-empty">
          No standby candidate adds {'≥'} the minimum gain right now: every off-shift physician is excluded or covers no gap-risk cell (see the candidate ledger).
        </p>
      )}
      {cards.map((c) => (
        <Card key={c.key} sel={c.sel} live={c.live} plan={plan} names={names} />
      ))}
      {plan.emptyBenchHospitals.length > 0 && (
        <div className="space-y-1" data-testid="empty-bench">
          {plan.emptyBenchHospitals.map((h) => (
            <div key={h.hospitalId} className="rounded-lg border border-critical/60 bg-critical/10 p-2 text-[12px]" data-testid="empty-bench-hospital" data-hospital-id={h.hospitalId}>
              <div className="flex items-center gap-2">
                <Chip tone="critical">EMPTY BENCH</Chip>
                <span className="font-semibold text-text">{h.hospitalName}</span>
                <span className="num text-muted">max P(gap) {pct(h.maxPGap)}</span>
              </div>
              <div className="mt-0.5 text-muted">No standby candidate for {shortName(h.hospitalName)}: {h.why}</div>
            </div>
          ))}
        </div>
      )}
      <div className="rounded-lg border border-border">
        <button type="button" onClick={() => setLedgerOpen((o) => !o)} aria-expanded={ledgerOpen} data-testid="bench-ledger-toggle" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-muted hover:text-text">
          <span>{ledgerOpen ? '▾' : '▸'}</span>
          Candidate ledger: {plan.candidates.length} off-shift physicians · {plan.candidates.filter((c) => c.eligible).length} eligible · each exclusion names its rule
        </button>
        {ledgerOpen && (
          <ul className="space-y-1 border-t border-border p-2" data-testid="bench-ledger">
            {plan.candidates.map((c) => (
              <li key={c.physicianId} data-testid="bench-candidate" data-eligible={c.eligible} className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-semibold text-text">{c.name}</span>
                <span className="num text-muted">{c.physicianId}</span>
                {c.eligible ? <Chip tone="ok">ELIGIBLE</Chip> : <Chip tone="critical">EXCLUDED</Chip>}
                {c.failingRule !== null && (
                  <span className="num rounded border border-critical/70 bg-critical/15 px-1.5 py-0.5 text-[11px] text-critical" title={c.failingRule.detail}>
                    {c.failingRule.rule} ✗
                  </span>
                )}
                {c.eligible && c.window !== null && (
                  <span className="num text-muted">
                    {etHm(c.window.startMs)}–{etHm(c.window.endMs)} · {c.coveredCells} cell(s) · EUM {c.valueEUM} · P(accept) {pct(c.pAccept)} · burden {c.burden}
                  </span>
                )}
                <span className="ml-auto text-muted" title={c.reason}>
                  {c.alerts7d} alert(s) / 7 d
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
