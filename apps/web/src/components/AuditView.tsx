'use client';

import type { AuditTrail } from '@lookahead/engine';
import { useEffect, useState } from 'react';
import type { ViewDTO } from '@/lib/dto';
import { etEnd, etHm, etHms } from '@/lib/format';
import { LiveProvider, useLive } from './live';
import { TopBar } from './TopBar';
import { Chip, NeedChip, Panel, StatusPill } from './ui';

/**
 * /audit/[offerId] (brief "Log every offer: who was considered, who was
 * excluded and why, who approved, and the outcome"). Read from the engine's
 * auditTrail, which is built only from the frozen action log (D-60).
 */

const who = (a: { role: string; id: string } | null | undefined) => (a === null || a === undefined ? '—' : `${a.role.replace('_', ' ')} (${a.id})`);

function Trail({ t }: { readonly t: AuditTrail }) {
  const steps: { at: number | null; label: string; detail: string }[] = [
    { at: t.proposed.atMs, label: 'Proposed', detail: `by ${who(t.proposed.by)}` },
    ...(t.approved === null ? [] : [{ at: t.approved.atMs, label: 'Approved', detail: `by ${who(t.approved.by)}${t.approved.note === null ? '' : ` — ${t.approved.note}`}` }]),
    ...(t.rejected === null ? [] : [{ at: t.rejected.atMs, label: 'Rejected', detail: `by ${who(t.rejected.by)}: ${t.rejected.reason}` }]),
    ...(t.sentAtMs === null ? [] : [{ at: t.sentAtMs, label: 'Sent (simulated)', detail: `via ${t.channel}` }]),
    { at: t.outcome.atMs, label: `Outcome: ${t.outcome.status}`, detail: `${t.outcome.by === null ? '' : `by ${who(t.outcome.by)} — `}${t.outcome.detail}` },
  ];
  return (
    <main className="scroll-thin flex-1 space-y-3 overflow-y-auto p-3" data-testid="audit">
      <Panel title={<>Audit · offer <span className="num normal-case">{t.offerId}</span></>} right={<a href="/api/audit.csv" className="text-[14px] font-semibold text-info underline" data-testid="audit-csv">Download CSV (all offers)</a>}>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 p-4">
          <div className="space-y-2 text-[15px]">
            <div className="flex items-center gap-3">
              <StatusPill status={t.outcome.status} />
              <span className="text-[22px] font-semibold">{t.name}</span>
              <span className="num text-muted">{t.physicianId}</span>
            </div>
            <div className="text-muted">
              window <span className="num text-text">{etHm(t.window.startMs)}–{etHm(t.window.endMs)} ET</span> · routing scope <span className="num text-text">{t.routingScope.join(', ')}</span> · seeded at <span className="num text-text">{t.seededConsultCount}</span> (split-shift trap mitigation)
            </div>
            <div className="flex flex-wrap gap-2">
              {t.needs.map((n) => (
                <span key={n.id} className="flex items-center gap-1.5 text-[13px]">
                  <NeedChip kind={n.kind} /> {n.hospitalName} <span className="num text-muted">{etHm(n.startMs)}–{etEnd(n.endMs)}</span>
                </span>
              ))}
            </div>
            <div className="rounded-md border border-border bg-bg/60 p-3">
              <div className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-muted">Message as sent (PHI-checked)</div>
              <pre className="num whitespace-pre-wrap text-[13px] text-text">{t.messageText}</pre>
            </div>
          </div>
          <ol className="space-y-2">
            {steps.map((s) => (
              <li key={s.label} className="flex gap-3 text-[15px]">
                <span className="num w-[84px] shrink-0 text-muted">{s.at === null ? '—' : etHms(s.at)}</span>
                <span>
                  <span className="font-semibold">{s.label}</span> <span className="text-muted">{s.detail}</span>
                </span>
              </li>
            ))}
            {t.coverageEffect !== null && (
              <li className="ml-[96px] text-[14px] text-ok">
                Coverage effect: {t.coverageEffect.filledNeedIds.length} needs filled;{' '}
                {t.coverageEffect.changes
                  .filter((c) => c.outcome !== 'unchanged')
                  .map((c) => `${c.kind} ${c.hospitalId} ${c.outcome}`)
                  .join('; ')}
              </li>
            )}
            {t.cancellationsCaused.map((c) => (
              <li key={c.offerId} className="ml-[96px] text-[14px] text-muted">
                {c.type.replace('offer_', '')} {c.offerId} at {etHms(c.atMs)}: {c.reason}
              </li>
            ))}
          </ol>
        </div>
      </Panel>
      <Panel title={<>Who was considered · {t.considered.length} off-shift physicians</>}>
        <table className="w-full text-[14px]" data-testid="audit-considered">
          <thead className="text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="px-4 py-2 text-left">Physician</th>
              <th className="px-4 py-2 text-left">Verdict</th>
              <th className="px-4 py-2 text-left">Why (every failed rule, with numbers)</th>
            </tr>
          </thead>
          <tbody>
            {t.considered.map((c) => (
              <tr key={c.physicianId} className="border-t border-border/60 align-top" data-testid="audit-physician">
                <td className="px-4 py-2">
                  <div className="font-semibold">{c.name}</div>
                  <div className="num text-[12px] text-muted">{c.physicianId}</div>
                </td>
                <td className="px-4 py-2">{c.eligible ? <Chip tone="ok">ELIGIBLE #{c.rank}</Chip> : <Chip tone="critical">EXCLUDED</Chip>}</td>
                <td className="px-4 py-2 text-[13px]">
                  {c.eligible ? (
                    <span className="text-muted">passed all {c.rules.filter((r) => r.pass !== null).length} applicable rules</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {c.rules
                        .filter((r) => r.pass === false)
                        .map((r) => (
                          <li key={r.rule}>
                            <span className="num text-critical">{r.rule}</span> <span className="text-muted">{r.detail}</span>
                          </li>
                        ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </main>
  );
}

function Body({ offerId, initialTrail }: { readonly offerId: string; readonly initialTrail: AuditTrail | null }) {
  const { view } = useLive();
  const [trail, setTrail] = useState(initialTrail);
  const seq = view?.logSeq;
  useEffect(() => {
    let alive = true;
    void fetch(`/api/audit/${encodeURIComponent(offerId)}`, { cache: 'no-store' }).then(async (r) => {
      if (alive && r.ok) setTrail((await r.json()) as AuditTrail);
    });
    return () => {
      alive = false;
    };
  }, [offerId, seq]);
  if (trail === null) return <p className="p-8 text-muted">No offer {offerId} in the action log.</p>;
  return <Trail t={trail} />;
}

export function AuditView({ initial, offerId, trail }: { readonly initial: ViewDTO | null; readonly offerId: string; readonly trail: AuditTrail | null }) {
  return (
    <LiveProvider initial={initial}>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <Body offerId={offerId} initialTrail={trail} />
      </div>
    </LiveProvider>
  );
}
