'use client';

import type { ViewDTO } from '@/lib/dto';
import { ActPanel } from './ActPanel';
import { AttentionList } from './AttentionList';
import { CoverageGrid } from './CoverageGrid';
import { LiveProvider, useLive } from './live';
import { TopBar } from './TopBar';

function Console() {
  const { view } = useLive();
  if (view === null) return <p className="p-8 text-muted">Loading the command center…</p>;
  return (
    <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,30fr)_minmax(0,40fr)_minmax(0,30fr)] gap-3 p-3">
      <AttentionList items={view.attention} />
      <CoverageGrid grid={view.coverage} demand={view.demand} needs={view.needs} />
      <ActPanel view={view} />
    </main>
  );
}

/** "/": projector-first ops console. Three columns: NOW, NEXT 2 HOURS, ACT. */
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
