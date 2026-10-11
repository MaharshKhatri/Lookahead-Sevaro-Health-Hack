import type { Metadata } from 'next';
import { DesignSheet } from '@/components/DesignSheet';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Design system' };

/** /design: every kit component in every state, Night and Day, on live engine data (UI pass). */
export default async function Page() {
  return <DesignSheet view={computeView((await getReadyStore()).snapshot())} />;
}
