'use client';

import { Fragment, useState } from 'react';
import type { Need } from '@lookahead/engine';
import type { CellClass, CoverageCellDTO, CoverageGridDTO, CoverageRowDTO, DemandChipDTO } from '@/lib/dto';
import { etEnd, etHm, localHm, zoneAbbr } from '@/lib/format';
import { CLASS_WORD, Chip, ClassChip, NeedChip, Panel, cx, shortName } from './ui';
import { Pips } from '@/ui/kit';

/**
 * CENTER "NEXT 2 HOURS — coverage": hospitals x 15-min buckets from now
 * (engine projection, OQ-24(a)/OQ-29). Cells read "confirmed+expected/required";
 * class colour plus a word (never colour-only). Vertical markers at shift
 * changes; a "now" line at the left edge.
 */

const RANK: Record<CellClass, number> = { OK: 0, AT_RISK: 1, HARD_GAP: 2, DEADLOCK: 3 };

const CELL: Record<CellClass, string> = {
  OK: 'bg-ok/8 text-text/80',
  AT_RISK: 'bg-warning/18 text-warning pat-at-risk',
  HARD_GAP: 'bg-critical/22 text-critical pat-hard-gap',
  DEADLOCK: 'bg-critical/40 text-text pat-deadlock font-bold',
};

function cellText(c: CoverageCellDTO): string {
  return c.staffedExpected > 0 ? `${c.staffedConfirmed}+${c.staffedExpected}/${c.required}` : `${c.staffedConfirmed}/${c.required}`;
}

function cellTitle(row: CoverageRowDTO, c: CoverageCellDTO): string {
  const lines = [
    `${row.hospitalName} ${etHm(c.startMs)}–${etHm(c.endMs)} ET: ${CLASS_WORD[c.class]}`,
    `required ${c.required}; staffed ${c.staffedConfirmed} confirmed + ${c.staffedExpected} expected (at ${etHm(c.atMs)})`,
  ];
  if (c.staffedIds.length > 0) lines.push(`counted: ${c.staffedIds.join(', ')}`);
  if (c.expectedIds.length > 0) lines.push(`expected (no shift_started yet): ${c.expectedIds.join(', ')}`);
  if (c.class === 'DEADLOCK') lines.push(`routable now: ${row.routableNow} (staffed is not routable: everyone credentialed here is busy or unavailable)`);
  return lines.join('\n');
}

function Row({ row, cells, markerStarts, nowMs }: { readonly row: CoverageRowDTO; readonly cells: readonly CoverageCellDTO[]; readonly markerStarts: ReadonlySet<number>; readonly nowMs: number }) {
  return (
    <tr data-testid={`coverage-row-${row.hospitalId}`} data-hospital-id={row.hospitalId}>
      <th scope="row" className="sticky left-0 z-10 border-b border-border bg-panel py-1 pl-3 pr-2 text-left align-middle font-normal">
        <div className="truncate text-[14px] font-semibold leading-tight text-text" title={row.hospitalName}>{row.hospitalName}</div>
        <div className="num flex items-center gap-1.5 text-[11px] text-muted">
          {cells[0] !== undefined && <Pips available={row.routableNow} required={cells[0].required} label={`${row.hospitalName} routable now against required`} />}
          <span>
            {row.hospitalId} · routable now {row.routableNow}
          </span>
          {row.timeZone !== 'America/New_York' && (
            <span className="text-ink3" title={`Local time at ${row.hospitalName} (${row.timeZone})`} data-testid="row-local-time">
              {localHm(nowMs, row.timeZone)} {zoneAbbr(nowMs, row.timeZone)}
            </span>
          )}
        </div>
      </th>
      {cells.map((c, i) => (
        <td
          key={c.startMs}
          title={cellTitle(row, c)}
          data-class={c.class}
          className={cx('border-b border-l border-border/70 p-0 text-center align-middle', markerStarts.has(c.startMs) && 'border-l-2 border-l-info', i === 0 && 'border-l-2 border-l-accent')}
        >
          <div className={cx('mx-[2px] my-[3px] flex h-[44px] flex-col items-center justify-center rounded', CELL[c.class])}>
            <span className="num text-[14px] leading-none">{cellText(c)}</span>
            {c.class !== 'OK' && <span className="mt-1 text-[8.5px] font-bold uppercase leading-none tracking-tight">{CLASS_WORD[c.class]}</span>}
          </div>
        </td>
      ))}
    </tr>
  );
}

export function CoverageGrid({ grid, demand, needs }: { readonly grid: CoverageGridDTO; readonly demand: readonly DemandChipDTO[]; readonly needs: readonly Need[] }) {
  const [span, setSpan] = useState<'2h' | 'all'>('2h');
  const [showOk, setShowOk] = useState(false);
  const end = span === '2h' ? grid.detectionHorizonEndMs : grid.horizonEndMs;
  const idx = grid.buckets.map((b, i) => (b.startMs < end ? i : -1)).filter((i) => i >= 0);
  const buckets = idx.map((i) => grid.buckets[i]).filter((b) => b !== undefined);
  const view = grid.rows.map((r) => {
    const cells = idx.map((i) => r.cells[i]).filter((c): c is CoverageCellDTO => c !== undefined);
    return { row: r, cells, worst: cells.reduce<CellClass>((w, c) => (RANK[c.class] > RANK[w] ? c.class : w), 'OK') };
  });
  const issues = view.filter((v) => v.worst !== 'OK').sort((a, b) => RANK[b.worst] - RANK[a.worst]);
  const ok = view.filter((v) => v.worst === 'OK');
  const markers = grid.markers.filter((m) => m.atMs < end);
  const markerStarts = new Set(markers.map((m) => m.atMs));
  const colCount = buckets.length + 1;

  return (
    <Panel
      testId="panel-coverage"
      className="h-full"
      title={
        <>
          {span === '2h' ? 'NEXT 2 HOURS' : 'NEXT 5 HOURS'} <span className="hidden normal-case tracking-normal text-text 2xl:inline">— coverage</span>
        </>
      }
      right={
        <div className="flex items-center gap-1.5">
          <ClassChip cls="OK" />
          <ClassChip cls="AT_RISK" />
          <ClassChip cls="HARD_GAP" />
          <ClassChip cls="DEADLOCK" />
          <div className="ml-2 flex overflow-hidden rounded-md border border-border">
            {(['2h', 'all'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSpan(s)} className={cx('whitespace-nowrap px-2 py-0.5 text-[12px] font-semibold', span === s ? 'bg-accent text-bg' : 'bg-raised text-muted')}>
                {s === '2h' ? '2 h' : '5 h'}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border px-4 py-2 text-[13px]">
        {markers.map((m) => (
          <span key={m.atMs} className="flex items-center gap-1.5 text-muted" data-testid="shift-marker">
            <span className="inline-block h-3 w-0.5 bg-info" />
            <span className="num text-text">{m.label}</span>
          </span>
        ))}
        {markers.length === 0 && <span className="text-muted">No shift changes in this window.</span>}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label="Coverage grid">
        <table className={cx('w-full table-fixed border-separate border-spacing-0', span === 'all' ? 'min-w-[1380px]' : 'min-w-[620px]')} data-testid="coverage-grid">
          <thead className="sticky top-0 z-20 bg-panel">
            <tr>
              <th className="sticky left-0 z-30 w-[164px] border-b border-border bg-panel px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                staffed / required
              </th>
              {buckets.map((b, i) => (
                <th key={b.startMs} className={cx('border-b border-l border-border/70 px-0.5 py-1.5 text-center', markerStarts.has(b.startMs) && 'border-l-2 border-l-info', i === 0 && 'border-l-2 border-l-accent')}>
                  <div className={cx('num text-[13px]', i === 0 ? 'font-semibold text-accent' : markerStarts.has(b.startMs) ? 'font-semibold text-info' : 'text-muted')}>{etHm(b.startMs)}</div>
                  <div className="text-[9px] uppercase tracking-wide text-muted">{i === 0 ? 'now' : markerStarts.has(b.startMs) ? 'shift chg' : ' '}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {issues.map((v) => (
              <Row key={v.row.hospitalId} nowMs={grid.nowMs} row={v.row} cells={v.cells} markerStarts={markerStarts} />
            ))}
            {ok.length > 0 && (
              <Fragment>
                <tr>
                  <td colSpan={colCount} className="border-b border-border px-3 py-1.5">
                    <button type="button" onClick={() => setShowOk((s) => !s)} className="flex items-center gap-2 text-[13px] text-muted hover:text-text" aria-expanded={showOk}>
                      <span>{showOk ? '▾' : '▸'}</span>
                      <Chip tone="ok">OK</Chip> all OK in this window ({ok.length}): {ok.map((v) => shortName(v.row.hospitalName)).join(', ')}
                    </button>
                  </td>
                </tr>
                {showOk && ok.map((v) => <Row key={v.row.hospitalId} nowMs={grid.nowMs} row={v.row} cells={v.cells} markerStarts={markerStarts} />)}
              </Fragment>
            )}
          </tbody>
        </table>
        <div className="px-4 pb-3 pt-3" data-testid="needs">
          <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted">Needs (decide layer) · start within 2 h</div>
          <ul className="space-y-1">
            {needs.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-2 text-[13px]" title={n.why.join('\n')}>
                <NeedChip kind={n.kind} />
                <span className="font-semibold">{shortName(n.hospitalName)}</span>
                <span className="num text-muted">
                  {etHm(n.startMs)}–{etEnd(n.endMs)}
                </span>
                {n.required !== null && (
                  <span className="num text-muted">
                    need {n.required}: {n.staffedConfirmed} confirmed + {n.staffedExpected} expected
                  </span>
                )}
                {n.consultIds.length > 0 && <span className="num text-muted">{n.consultIds.join(', ')}</span>}
                <span className={cx('ml-auto text-[11px] uppercase tracking-wide', n.qualifiesForOffers ? 'text-accent' : 'text-muted')}>{n.qualifiesForOffers ? 'offer-qualifying' : 'advisory'}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-muted">Demand</span>
        {demand.length === 0 && <span className="text-[13px] text-muted">no hospital above its p90 baseline</span>}
        {demand.map((d) => (
          <span key={d.hospitalId} data-testid="demand-chip" title={`${d.hospitalName}: ${d.count} consults received in the trailing 60 min vs p90 ${d.p90 ?? '-'} (mean ${d.mean ?? '-'}) for the ${d.baselineHourEt ?? '-'} ET hour; +1 required while spiking. ${d.contributingConsultIds.join(', ')}`}>
            <Chip tone="warning" className="text-[13px] normal-case tracking-normal">
              <span className="uppercase">SPIKE</span> {shortName(d.hospitalName)} <span className="num">{d.count}/hr</span> vs p90 <span className="num">{d.p90 ?? '-'}</span>
            </Chip>
          </span>
        ))}
        <span className="ml-auto text-[12px] text-muted">cells: confirmed+expected / required · hover for who</span>
      </div>
    </Panel>
  );
}
