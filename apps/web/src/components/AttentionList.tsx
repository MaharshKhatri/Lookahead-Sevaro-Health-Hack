'use client';

import { useEffect, useState } from 'react';
import type { Incident, NextBestAction } from '@lookahead/engine';
import type { AttentionDTO } from '@/lib/dto';
import { IncidentList } from './Incidents';
import { relMinutes } from '@/lib/format';
import { Explain } from './Explain';
import { EvidenceChip, Panel, cx } from './ui';
import { Button as KitButton, Chip as KitChip, PRIORITY_WORD, PriorityGlyph, severityPriority } from '@/ui/kit';

/**
 * LEFT "NOW — what needs attention": the engine's ranked attention list
 * (brief "Detect and rank what needs attention, and explain why each item was
 * flagged"). Click a card to see its why-bullets, score breakdown and evidence.
 */

const KIND_LABEL: Record<string, string> = {
  ROUTING_DEADLOCK: 'Routing deadlock',
  STANDARD_BREACH: 'Time standard breached',
  IMMINENT_BREACH: 'Breach imminent',
  COVERAGE_GAP: 'Coverage gap',
  DEMAND_SPIKE: 'Demand spike',
  OPEN_NOTES_NEAR_SHIFT_END: 'Open notes near shift end',
  SIGNAL_CONFLICT: 'Conflicting signals',
};

const FACTOR_COLORS = ['bg-critical', 'bg-warning', 'bg-info', 'bg-accent', 'bg-ok', 'bg-muted', 'bg-text'];

function factorLabel(f: string): string {
  return f.replace(/^kind:/, '').replace(/^level:/, 'level ').replace(/^signal:/, '').replace(/_/g, ' ').toLowerCase();
}

export function ScoreBar({ item }: { readonly item: AttentionDTO }) {
  const total = item.scoreBreakdown.reduce((a, f) => a + Math.max(0, f.points), 0) || 1;
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-raised" aria-label={`score ${item.score}`}>
        {item.scoreBreakdown.map((f, i) => (
          <div key={f.factor} className={FACTOR_COLORS[i % FACTOR_COLORS.length]} style={{ width: `${(Math.max(0, f.points) / total) * 100}%` }} title={`${f.factor} ${f.points}`} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
        {item.scoreBreakdown.map((f, i) => (
          <span key={f.factor} className="flex items-center gap-1">
            <span className={cx('inline-block h-2 w-2 rounded-sm', FACTOR_COLORS[i % FACTOR_COLORS.length])} />
            {factorLabel(f.factor)} <span className="num text-text">{f.points}</span>
          </span>
        ))}
        <span className="ml-auto">
          = <span className="num font-semibold text-text">{item.score}</span>
        </span>
      </div>
    </div>
  );
}

function Card({ item, top, open, onToggle, action }: { readonly item: AttentionDTO; readonly top: boolean; readonly open: boolean; readonly onToggle: () => void; readonly action: NextBestAction | null }) {
  const pr = severityPriority(item.severity);
  const rule = pr === 'P1' ? 'border-l-critical' : pr === 'P2' ? 'border-l-warning' : pr === 'P3' ? 'border-l-info' : 'border-l-border';
  return (
    <article
      data-testid={top ? 'attention-top' : 'attention-card'}
      data-attention-id={item.id}
      data-hospital-ids={item.hospitalIds.join(' ')}
      className={cx('rounded-[2px] border border-l-2 border-border bg-panel transition-colors', rule, top && 'bg-raised/60')}
    >
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full px-3 py-2.5 text-left">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
          <PriorityGlyph p={pr} />
          <span className={pr === 'P1' ? 'text-critical' : pr === 'P2' ? 'text-warning' : 'text-muted'}>{PRIORITY_WORD[pr].toUpperCase()}</span>
          {item.strokeAtRisk && <span className="text-critical">· Stroke</span>}
          <span className="font-normal normal-case tracking-normal text-muted">{KIND_LABEL[item.kind] ?? item.kind}</span>
          <span className={cx('num ml-auto whitespace-nowrap text-[13px] normal-case tracking-normal', item.timeToImpactMs <= 0 ? 'text-critical' : 'text-warning')}>{item.timeToImpactMs <= 0 ? 'now' : `in ${relMinutes(item.timeToImpactMs)}`}</span>
        </div>
        <h3 data-testid="attention-headline" className={cx('mt-1 font-semibold leading-snug text-text', top ? 'text-[18px]' : 'text-[15px]')}>
          {item.headline}
        </h3>
        {item.why[0] !== undefined && <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted">{item.why[0]}</p>}
        {item.consultIds.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {item.consultIds.slice(0, 3).map((c) => (
              <KitChip key={c} id>
                {c}
              </KitChip>
            ))}
          </div>
        )}
      </button>
      {action !== null && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-[13px]">
          <span className="min-w-0 flex-1 truncate text-text" title={action.title}>
            <span className="text-muted">Recommended: </span>
            {action.title}
          </span>
          <KitButton kind="primary" data-testid="attention-propose" onClick={() => window.dispatchEvent(new CustomEvent('lookahead:propose', { detail: { actionId: action.id } }))}>
            Propose
          </KitButton>
        </div>
      )}
      {open && (
        <div className="space-y-3 border-t border-border px-3 pb-3 pt-2.5">
          <ul className="space-y-1.5 text-[13px] leading-snug text-text/90">
            {item.why.map((w) => (
              <li key={w} className="flex gap-2">
                <span className="mt-[7px] inline-block h-1 w-1 shrink-0 bg-muted" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
          <ScoreBar item={item} />
          <Explain kind="attention" id={item.id} />
          <div className="flex flex-wrap gap-1.5">
            {item.because.map((e) => (
              <EvidenceChip key={e.eventId} e={e} />
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

export function AttentionList({ items, incidents, reduction }: { readonly items: readonly AttentionDTO[]; readonly incidents?: readonly Incident[]; readonly reduction?: { readonly items: number; readonly incidents: number; readonly percent: number } }) {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<'incidents' | 'items'>('items');
  const topId = items[0]?.id;
  const isOpen = (id: string) => openIds[id] ?? id === topId;
  const showIncidents = mode === 'incidents' && incidents !== undefined;
  // Line 4 of a queue item: the engine's recommended action for the incident this item belongs to (D-95).
  // Command palette focus jumps (UI pass): `lookahead:focus` {kind, id} or a `?focus=kind:id` link scrolls to and flashes the matching element.
  useEffect(() => {
    const flash = (kind: string, id: string) => {
      if (kind === 'incident') setMode('incidents');
      window.setTimeout(() => {
        const sel = kind === 'incident' ? `[data-incident-id="${CSS.escape(id)}"]` : kind === 'hospital' ? `[data-hospital-id="${CSS.escape(id)}"], [data-hospital-ids~="${CSS.escape(id)}"]` : `[data-physician-id="${CSS.escape(id)}"]`;
        const el = document.querySelector<HTMLElement>(sel);
        if (el === null) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash-focus');
        window.setTimeout(() => el.classList.remove('flash-focus'), 1600);
      }, 50);
    };
    const onFocus = (e: Event) => {
      const d = (e as CustomEvent<{ kind?: string; id?: string }>).detail;
      if (d?.kind !== undefined && d.id !== undefined) flash(d.kind, d.id);
    };
    const q = new URLSearchParams(window.location.search).get('focus');
    if (q !== null && q.includes(':')) flash(q.slice(0, q.indexOf(':')), q.slice(q.indexOf(':') + 1));
    window.addEventListener('lookahead:focus', onFocus);
    return () => window.removeEventListener('lookahead:focus', onFocus);
  }, []);
  const actionOf = (id: string): NextBestAction | null => incidents?.find((inc) => inc.memberItemIds.includes(id))?.recommendedAction ?? null;
  return (
    <Panel
      testId="panel-now"
      className="h-full"
      title={
        <>
          NOW <span className="normal-case tracking-normal text-text">— what needs attention</span>
        </>
      }
      right={
        <div className="flex items-center gap-2">
          {incidents !== undefined && (
            <div className="flex rounded border border-border text-[12px]" role="tablist" aria-label="group attention items">
              <button type="button" role="tab" data-testid="now-mode-incidents" aria-selected={showIncidents} onClick={() => setMode('incidents')} className={cx('px-2 py-0.5', showIncidents ? 'bg-raised text-text' : 'text-muted hover:text-text')}>
                Incidents
              </button>
              <button type="button" role="tab" data-testid="now-mode-items" aria-selected={!showIncidents} onClick={() => setMode('items')} className={cx('px-2 py-0.5', !showIncidents ? 'bg-raised text-text' : 'text-muted hover:text-text')}>
                Items
              </button>
            </div>
          )}
          <span className="num text-[13px] text-muted" data-testid="now-count">
            {showIncidents && reduction !== undefined ? `${reduction.items} items → ${reduction.incidents} incidents (−${reduction.percent}%)` : `${items.filter((i) => i.severity === 'critical').length} critical · ${items.length} items`}
          </span>
        </div>
      }
    >
      {/* Assertive announcements for P1 only (UI pass accessibility): the top critical headline. */}
      <div aria-live="assertive" className="sr-only">
        {items[0]?.severity === 'critical' ? `Critical: ${items[0].headline}` : ''}
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto">
        {showIncidents ? (
          <IncidentList incidents={incidents} items={items} />
        ) : (
          <div className="space-y-2 p-2.5">
            {items.map((it, i) => (
              <Card key={it.id} item={it} top={i === 0} open={isOpen(it.id)} action={actionOf(it.id)} onToggle={() => setOpenIds((o) => ({ ...o, [it.id]: !isOpen(it.id) }))} />
            ))}
            {items.length === 0 && <p className="p-4 text-muted">Nothing needs attention at this instant.</p>}
          </div>
        )}
      </div>
    </Panel>
  );
}
