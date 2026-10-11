'use client';

import { useState } from 'react';
import type { Incident } from '@lookahead/engine';
import type { AttentionDTO } from '@/lib/dto';
import { IncidentList } from './Incidents';
import { relMinutes } from '@/lib/format';
import { Explain } from './Explain';
import { EvidenceChip, Panel, SeverityChip, StrokeTag, cx } from './ui';

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

function Card({ item, top, open, onToggle }: { readonly item: AttentionDTO; readonly top: boolean; readonly open: boolean; readonly onToggle: () => void }) {
  return (
    <article
      data-testid={top ? 'attention-top' : 'attention-card'}
      data-attention-id={item.id}
      className={cx(
        'rounded-lg border bg-raised/60 transition-colors',
        top ? 'border-critical/80 bg-critical/8 pulse-critical' : 'border-border hover:border-muted/60',
      )}
    >
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full px-3.5 py-3 text-left">
        <div className="flex items-center gap-2">
          <span className={cx('num font-semibold', top ? 'text-[22px] text-text' : 'text-[15px] text-muted')}>#{item.rank}</span>
          <SeverityChip severity={item.severity} />
          {item.strokeAtRisk && <StrokeTag />}
          <span className="text-[12px] text-muted">{KIND_LABEL[item.kind] ?? item.kind}</span>
          <span className={cx('num ml-auto whitespace-nowrap font-semibold', item.timeToImpactMs <= 0 ? 'text-critical' : 'text-warning', top ? 'text-[16px]' : 'text-[13px]')}>
            {item.timeToImpactMs <= 0 ? 'NOW' : relMinutes(item.timeToImpactMs)}
          </span>
        </div>
        <h3 data-testid="attention-headline" className={cx('mt-1.5 font-semibold leading-snug text-text', top ? 'text-[20px]' : 'text-[16px]')}>
          {item.headline}
        </h3>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3.5 pb-3.5 pt-3">
          <ul className="space-y-1.5 text-[14px] leading-snug text-text/90">
            {item.why.map((w) => (
              <li key={w} className="flex gap-2">
                <span className="mt-[7px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
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
  const [mode, setMode] = useState<'incidents' | 'items'>(incidents === undefined ? 'items' : 'incidents');
  const topId = items[0]?.id;
  const isOpen = (id: string) => openIds[id] ?? id === topId;
  const showIncidents = mode === 'incidents' && incidents !== undefined;
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
      <div className="scroll-thin flex-1 overflow-y-auto">
        {showIncidents ? (
          <IncidentList incidents={incidents} items={items} />
        ) : (
          <div className="space-y-2.5 p-3">
            {items.map((it, i) => (
              <Card key={it.id} item={it} top={i === 0} open={isOpen(it.id)} onToggle={() => setOpenIds((o) => ({ ...o, [it.id]: !isOpen(it.id) }))} />
            ))}
            {items.length === 0 && <p className="p-4 text-muted">Nothing needs attention at this instant.</p>}
          </div>
        )}
      </div>
    </Panel>
  );
}
