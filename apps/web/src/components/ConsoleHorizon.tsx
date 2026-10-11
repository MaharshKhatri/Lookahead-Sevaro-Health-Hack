'use client';

import type { ViewDTO } from '@/lib/dto';
import { HorizonLine } from '@/ui/HorizonLine';
import { clearHighlight, highlight, select } from '@/ui/select';

/** The Horizon Line across the top of the command center (UI pass): hover cross-highlights related rows and cards; click opens the detail column. */
export function ConsoleHorizon({ view }: { readonly view: ViewDTO }) {
  return (
    <div className="border-b border-border bg-panel px-3" data-testid="console-horizon">
      <HorizonLine
        items={view.intel.timeline.items}
        nowMs={view.clock.nowMs}
        onHover={(m) => (m === null ? clearHighlight() : highlight(m.hospitalIds, m.physicianIds))}
        onSelect={(m) => select({ kind: 'marker', title: m.label, whenMs: m.tMs, endMs: m.endMs, detail: m.detail, hospitalIds: m.hospitalIds, physicianIds: m.physicianIds })}
      />
    </div>
  );
}
