'use client';

import { useState } from 'react';
import type { Incident } from '@lookahead/engine';
import type { AttentionDTO } from '@/lib/dto';
import { EvidenceChip, SeverityChip, StrokeTag, cx } from './ui';

/**
 * INCIDENTS (Phase 6, D-95): attention items grouped by shared cause, each
 * with the rule that linked them and its member items (raw items stay
 * reachable). Rendered inside the NOW panel behind an Items / Incidents toggle.
 */

const KIND_LABEL: Readonly<Record<string, string>> = {
  HOSPITAL_SURGE: 'Hospital surge',
  ROUTING_DEADLOCK: 'Stranded consult',
  PHYSICIAN_UNAVAILABLE_WITH_ASSIGNED: 'Unavailable with assigned',
  SHIFT_END_OPEN_NOTES: 'Shift end, open notes',
  COVERAGE_GAP: 'Coverage gap',
  SIGNAL_CONTRADICTION: 'Signal contradiction',
  STANDALONE: 'Single item',
};

export function IncidentList({ incidents, items }: { readonly incidents: readonly Incident[]; readonly items: readonly AttentionDTO[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const byId = new Map(items.map((i) => [i.id, i]));
  return (
    <div className="space-y-2.5 p-3" data-testid="incident-list">
      {incidents.map((inc, idx) => {
        const isOpen = open[inc.id] ?? idx === 0;
        return (
          <article key={inc.id} data-testid="incident-card" data-incident-id={inc.id} className={cx('rounded-lg border bg-raised/60', idx === 0 ? 'border-critical/80' : 'border-border')}>
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [inc.id]: !isOpen }))} className="w-full px-3.5 py-3 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <span className="num text-[15px] font-semibold text-muted">#{idx + 1}</span>
                <SeverityChip severity={inc.severity} />
                {inc.strokeAtRisk && <StrokeTag />}
                <span className="text-[12px] text-muted">{KIND_LABEL[inc.kind] ?? inc.kind}</span>
                <span className="num ml-auto rounded bg-raised px-1.5 text-[12px] text-muted" title="attention items in this incident">
                  {inc.memberItemIds.length} item{inc.memberItemIds.length === 1 ? '' : 's'}
                </span>
              </div>
              <h3 className="mt-1.5 text-[16px] font-semibold leading-snug text-text" data-testid="incident-headline">
                {inc.headline}
              </h3>
              {inc.recommendedAction !== null && (
                <div className="mt-1 text-[13px] text-accent">
                  → {inc.recommendedAction.title} <span className="text-muted">({inc.recommendedAction.expectedStrokeMinutesAverted} stroke-min averted)</span>
                </div>
              )}
            </button>
            {isOpen && (
              <div className="space-y-2 border-t border-border px-3.5 pb-3.5 pt-3 text-[13px]">
                <p className="text-muted">
                  <span className="font-semibold text-text">Linked by:</span> {inc.linkRule}
                </p>
                <ul className="space-y-1">
                  {inc.memberItemIds.map((id) => {
                    const it = byId.get(id);
                    return (
                      <li key={id} className="flex items-center gap-2 rounded border border-border bg-bg/50 px-2 py-1">
                        <span className="num text-muted">#{it?.rank ?? '?'}</span>
                        <span className="text-text">{it?.headline ?? id}</span>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-wrap gap-1.5">
                  {inc.because.slice(0, 8).map((e) => (
                    <EvidenceChip key={e.eventId} e={{ eventId: e.eventId, eventType: e.eventType, eventTimeMs: e.eventTimeMs }} />
                  ))}
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
