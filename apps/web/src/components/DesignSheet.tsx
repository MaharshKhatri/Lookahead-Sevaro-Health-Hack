'use client';

import type { ViewDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import { HorizonLine } from '@/ui/HorizonLine';
import { AnalogBar, Button, Chip, EmptyState, ErrorState, KitPanel, LoadingRules, Pips, PriorityGlyph, STATUS_STYLE, SectionTitle, Sparkline, StatusPill, cx, severityPriority } from '@/ui/kit';
import { THEMES } from '@/ui/tokens';

/**
 * /design: the living style guide (UI pass). Every kit component in every
 * state, in Night and Day, fed by the live engine view (no example numbers).
 */
function Sheet({ view, theme }: { readonly view: ViewDTO; readonly theme: 'night' | 'day' }) {
  const p = THEMES[theme];
  const top = view.attention.slice(0, 4);
  const demand = view.demand.slice(0, 4);
  const rows = view.coverage.rows.slice(0, 4);
  const firstCell = (r: (typeof rows)[number]) => r.cells[0];
  const past = view.forecast.hospitals[0]?.past.map((b) => b.count) ?? [];
  return (
    <div className={cx('space-y-4 bg-bg p-4 text-text', theme === 'day' && 'theme-day')} data-testid={`design-${theme}`}>
      <h2 className="text-[22px] font-semibold">{theme === 'night' ? 'Night' : 'Day'}</h2>
      <KitPanel title="Tokens">
        <div className="grid grid-cols-4 gap-2 p-3 text-[11px]">
          {Object.entries(p).map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="inline-block h-4 w-4 border border-border" style={{ background: v }} />
              <span className="num">
                {k} {v}
              </span>
            </div>
          ))}
        </div>
      </KitPanel>
      <KitPanel title="Buttons">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Button kind="primary">Propose</Button>
          <Button kind="secondary">Explain</Button>
          <Button kind="destructive">Reject</Button>
          <Button kind="ghost">Dismiss</Button>
          <Button kind="primary" disabled>
            Propose
          </Button>
          <div className="w-[240px]">
            <Button kind="primary" phone>
              Accept (phone)
            </Button>
          </div>
        </div>
      </KitPanel>
      <KitPanel title="Chips, priority, status">
        <div className="flex flex-wrap items-center gap-2 p-3">
          {(['critical', 'warning', 'ok', 'info', 'accent', 'neutral'] as const).map((t) => (
            <Chip key={t} tone={t}>
              {t}
            </Chip>
          ))}
          {top.slice(0, 2).flatMap((a) => a.consultIds.slice(0, 1)).map((id) => (
            <Chip key={id} id>
              {id}
            </Chip>
          ))}
          {(['P1', 'P2', 'P3', 'P4'] as const).map((x) => (
            <PriorityGlyph key={x} p={x} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2 px-3 pb-3">
          {Object.keys(STATUS_STYLE).map((s) => (
            <StatusPill key={s} status={s} />
          ))}
        </div>
      </KitPanel>
      <KitPanel title="Queue items (live attention)">
        <div className="divide-y divide-border">
          {top.map((a) => {
            const pr = severityPriority(a.severity);
            return (
              <div key={a.id} className={cx('border-l-2 px-3 py-2', pr === 'P1' ? 'border-critical' : pr === 'P2' ? 'border-warning' : 'border-info')}>
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
                  <PriorityGlyph p={pr} /> {a.severity} · <span className="num">{a.timeToImpactMs <= 0 ? 'now' : `${Math.round(a.timeToImpactMs / 60_000)} min`}</span>
                </div>
                <p className="mt-0.5 text-[15px] font-semibold">{a.headline}</p>
                <p className="text-[13px] text-muted">{a.why[0]}</p>
              </div>
            );
          })}
          {top.length === 0 && <EmptyState title="Nothing needs attention at this instant." />}
        </div>
      </KitPanel>
      <KitPanel title="Hospital rows (analog bar, pips, sparkline)">
        <div className="divide-y divide-border">
          {demand.map((d) => {
            const row = rows.find((r) => r.hospitalId === d.hospitalId) ?? rows[0];
            const c = row === undefined ? undefined : firstCell(row);
            return (
              <div key={d.hospitalId} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="w-44 truncate font-semibold">{d.hospitalName}</span>
                <AnalogBar value={d.count} normalMax={d.p90} max={Math.max(d.count, d.p90 ?? 0, 4)} label={`${d.hospitalName} trailing 60 min`} />
                {c !== undefined && <Pips available={c.staffedConfirmed + c.staffedExpected} required={c.required} label={`${d.hospitalName} coverage`} />}
                <Sparkline values={past} label="consults per 15 min, last 3 h" />
              </div>
            );
          })}
        </div>
      </KitPanel>
      <KitPanel title="Horizon line (live)">
        <HorizonLine items={view.intel.timeline.items} nowMs={view.clock.nowMs} />
      </KitPanel>
      <KitPanel title="States">
        <EmptyState title="All stroke consults assigned." detail={`as of ${etHm(view.clock.nowMs)} ET`} />
        <ErrorState title="The forecast could not be computed." detail="The engine error text appears here." />
        <LoadingRules />
      </KitPanel>
      <SectionTitle>Type scale</SectionTitle>
      <div className="space-y-1 px-3">
        <p className="text-[44px] leading-tight">Display 44</p>
        <p className="text-[28px]">H1 28</p>
        <p className="text-[22px]">H2 22</p>
        <p className="text-[18px]">H3 18</p>
        <p className="text-[15px]">Body 15</p>
        <p className="text-[13px] text-muted">Small 13 (ink-2)</p>
        <p className="text-[11px] text-ink3">Micro 11 (ink-3)</p>
      </div>
    </div>
  );
}

export function DesignSheet({ view }: { readonly view: ViewDTO }) {
  return (
    <main data-testid="design" className="grid grid-cols-1 gap-0 xl:grid-cols-2">
      <Sheet view={view} theme="night" />
      <Sheet view={view} theme="day" />
    </main>
  );
}
