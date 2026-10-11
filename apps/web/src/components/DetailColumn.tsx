'use client';

import { useEffect, useState } from 'react';
import type { ViewDTO } from '@/lib/dto';
import { etHm, localHm, zoneAbbr } from '@/lib/format';
import { Button, Chip, SectionTitle } from '@/ui/kit';
import { type Selection, clearHighlight, highlight } from '@/ui/select';

/**
 * DETAIL (UI pass): the Level-3 content of whatever was selected (a Horizon
 * Line marker, a hospital, an incident) replaces popovers and modals. Shows
 * the engine's sentence, the related attention items and the engine's
 * recommended action for them, with one-click Propose. Esc closes.
 */
export function DetailColumn({ view }: { readonly view: ViewDTO }) {
  const [sel, setSel] = useState<Selection | null>(null);
  useEffect(() => {
    const on = (e: Event) => setSel((e as CustomEvent<Selection | null>).detail);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setSel(null);
    window.addEventListener('lookahead:select', on);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('lookahead:select', on);
      window.removeEventListener('keydown', esc);
    };
  }, []);
  useEffect(() => {
    if (sel === null) clearHighlight();
    else highlight(sel.hospitalIds, sel.physicianIds);
  }, [sel]);
  if (sel === null) return null;
  const names = new Map(view.coverage.rows.map((r) => [r.hospitalId, r.hospitalName]));
  const zones = new Map(view.coverage.rows.map((r) => [r.hospitalId, r.timeZone]));
  const items = view.attention.filter((a) => a.hospitalIds.some((h) => sel.hospitalIds.includes(h)) || a.physicianIds.some((p) => sel.physicianIds.includes(p)));
  const incidents = view.intel.incidents.filter((i) => i.memberItemIds.some((m) => items.some((a) => a.id === m)));
  const actions = incidents.flatMap((i) => (i.recommendedAction === null ? [] : [i.recommendedAction])).filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i);
  return (
    <section data-testid="detail-column" aria-label="Detail" className="border-b border-border bg-raised/40">
      <SectionTitle
        right={
          <button type="button" className="text-[13px] text-muted hover:text-text" onClick={() => setSel(null)} data-testid="detail-close">
            Close
          </button>
        }
      >
        Detail
      </SectionTitle>
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-[15px] font-semibold text-text" data-testid="detail-title">
          {sel.title}
        </p>
        {sel.whenMs !== null && (
          <p className="num text-[13px] text-muted">
            {etHm(sel.whenMs)}
            {sel.endMs !== null && `–${etHm(sel.endMs)}`} ET
          </p>
        )}
        <p className="text-[13px] leading-snug text-text/90">{sel.detail}</p>
        {sel.hospitalIds.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {sel.hospitalIds.map((h) => (
              <Chip key={h} tone="neutral">
                {names.get(h) ?? h}
                {zones.get(h) !== undefined && zones.get(h) !== 'America/New_York' && ` · ${localHm(view.clock.nowMs, zones.get(h) ?? '')} ${zoneAbbr(view.clock.nowMs, zones.get(h) ?? '')}`}
              </Chip>
            ))}
          </div>
        )}
        {items.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted">Related attention ({items.length})</p>
            <ul className="mt-1 space-y-1 text-[13px]">
              {items.slice(0, 5).map((a) => (
                <li key={a.id} className="truncate text-text" title={a.headline}>
                  <span className="num text-muted">#{a.rank}</span> {a.headline}
                </li>
              ))}
            </ul>
          </div>
        )}
        {actions.slice(0, 2).map((a) => (
          <div key={a.id} className="flex items-center gap-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate" title={a.title}>
              {a.title}
            </span>
            <Button kind="primary" onClick={() => window.dispatchEvent(new CustomEvent('lookahead:propose', { detail: { actionId: a.id } }))}>
              Propose
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
