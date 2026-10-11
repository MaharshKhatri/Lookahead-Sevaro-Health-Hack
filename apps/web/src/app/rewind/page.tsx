import type { Metadata } from 'next';
import { RewindView } from '@/components/RewindView';
import { clinicalConstants } from '@/server/opener';
import { rewindFor } from '@/server/rewind';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Rewind' };

/** /rewind: the counterfactual replay of the day (Phase 5, D-94), computed once per dataset version. */
export default async function Page() {
  const s = (await getReadyStore()).snapshot();
  return <RewindView initial={computeView(s)} report={rewindFor(s)} clinical={clinicalConstants()} />;
}
