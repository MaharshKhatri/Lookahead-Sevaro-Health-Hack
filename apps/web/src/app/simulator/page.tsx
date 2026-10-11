import type { Metadata } from 'next';
import { Simulator } from '@/components/Simulator';
import { simulatorEnabled } from '@/server/simulator';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Upstream Event Simulator · Lookahead' };

/** /simulator (sprint B1): demo-only upstream feed stand-in; an honest disabled state when SIMULATOR_ENABLED is off. */
export default async function Page() {
  const enabled = simulatorEnabled();
  return <Simulator enabled={enabled} initial={computeView((await getReadyStore()).snapshot())} />;
}
