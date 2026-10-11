'use client';

import { useEffect, useState } from 'react';
import type { ViewDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import { SurgeRadar } from './SurgeRadar';
import { useDeltas } from './useDelta';

/**
 * /embed/surge (Phase 8, D-96): the Surge Radar alone, sized for an iframe in
 * a partner dashboard. Read-only; refetches /api/view when /api/stream says the
 * version changed (same contract as the console), so it stays live without
 * any control surface. Embeddable from LOOKAHEAD_EMBED_ORIGINS (CSP, middleware).
 */
export function EmbedSurge({ initial, limit }: { readonly initial: ViewDTO; readonly limit: number }) {
  const [view, setView] = useState<ViewDTO>(initial);
  const deltas = useDeltas(view);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let timer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void fetch('/api/view')
          .then((r) => (r.ok ? (r.json() as Promise<ViewDTO>) : null))
          .then((v) => {
            if (v !== null) setView(v);
          })
          .catch(() => undefined);
      }, 200);
    };
    return () => {
      es.close();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return (
    <div data-testid="embed-surge" className="flex h-screen flex-col overflow-hidden bg-bg text-text">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[12px] text-muted">
        <span>
          <span className="font-semibold text-text">Lookahead</span> · surge radar · as of <span className="num text-text">{etHm(view.clock.nowMs)}</span> ET
        </span>
        <span className="num">
          {view.forecast.hospitals.filter((h) => h.spikeNow).length} spiking · {view.forecast.hospitals.length} hospitals
        </span>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <SurgeRadar forecast={view.forecast} deltas={deltas} limit={limit} />
      </div>
    </div>
  );
}
