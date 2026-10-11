'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ViewDTO } from '@/lib/dto';
import { ActPanel } from './ActPanel';
import { AttentionList } from './AttentionList';
import { CoverageGrid } from './CoverageGrid';
import { DeltaChip } from './DeltaChip';
import { LiveProvider, useLive } from './live';
import { PolicyPanel } from './PolicyPanel';
import { StandbyBench } from './StandbyBench';
import { SurgeRadar } from './SurgeRadar';
import { TopBar } from './TopBar';
import { Panel, cx } from './ui';
import { useDeltas } from './useDelta';

type Tab = 'radar' | 'bench' | 'policy';

/** Middle-column lower panel (Phase 7): SURGE RADAR / STANDBY BENCH / POLICY tabs under the coverage grid. */
function Foresight({ view }: { readonly view: ViewDTO }) {
  const [tab, setTab] = useState<Tab>('radar');
  const deltas = useDeltas(view);
  const standbys = view.standby?.standbys ?? [];
  const liveCount = standbys.filter((s) => !['declined', 'rejected', 'expired', 'cancelled', 'released'].includes(s.status)).length;
  const spiking = view.forecast?.hospitals.filter((h) => h.spikeNow).length ?? 0;
  const tabs: { id: Tab; label: string; badge?: string | undefined; testId: string }[] = [
    { id: 'radar', label: 'Surge radar', badge: spiking > 0 ? `${spiking} spiking` : undefined, testId: 'tab-radar' },
    { id: 'bench', label: 'Standby bench', badge: `${view.standby?.plan.selected.length ?? 0} selected${liveCount > 0 ? ` · ${liveCount} live` : ''}`, testId: 'tab-bench' },
    { id: 'policy', label: 'Policy', badge: String(view.policy?.length ?? 0), testId: 'tab-policy' },
  ];
  return (
    <Panel
      testId="panel-foresight"
      className="h-full"
      title={
        <>
          NEXT 3 HOURS <span className="normal-case tracking-normal text-text">— forecast and standby</span>
        </>
      }
      right={
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <span className="flex items-center gap-1" data-testid="attention-count">
            attention <span className="num text-text">{view.attention.length}</span>
            <DeltaChip d={deltas.get('attention')} />
          </span>
          <Link href="/quality" className="text-info underline" data-testid="link-quality">
            Quality
          </Link>
          <Link href="/rewind" className="text-info underline" data-testid="link-rewind">
            Rewind
          </Link>
        </div>
      }
    >
      <div className="flex border-b border-border bg-panel px-2" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" data-testid={t.testId} aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cx('flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-wider', tab === t.id ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')}>
            {t.label}
            {t.badge !== undefined && <span className="num rounded bg-raised px-1 text-[10px] normal-case tracking-normal text-muted">{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {tab === 'radar' && <SurgeRadar forecast={view.forecast} deltas={deltas} />}
        {tab === 'bench' && <StandbyBench view={view} deltas={deltas} />}
        {tab === 'policy' && <PolicyPanel policy={view.policy} />}
      </div>
    </Panel>
  );
}

function Console() {
  const { view } = useLive();
  if (view === null) return <p className="p-8 text-muted">Loading the command center…</p>;
  return (
    <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,30fr)_minmax(0,40fr)_minmax(0,30fr)] gap-3 p-3">
      <AttentionList items={view.attention} />
      <div className="flex min-h-0 flex-col gap-3">
        <div className="min-h-0 flex-[11]">
          <CoverageGrid grid={view.coverage} demand={view.demand} needs={view.needs} />
        </div>
        <div className="min-h-0 flex-[9]">
          <Foresight view={view} />
        </div>
      </div>
      <ActPanel view={view} />
    </main>
  );
}

/** "/": projector-first ops console. Three columns: NOW, NEXT 2 HOURS (+ forecast / standby below), ACT. */
export function CommandCenter({ initial }: { readonly initial: ViewDTO | null }) {
  return (
    <LiveProvider initial={initial}>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <Console />
      </div>
    </LiveProvider>
  );
}
