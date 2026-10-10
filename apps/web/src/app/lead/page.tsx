import type { Metadata } from 'next';
import { LeadInbox } from '@/components/LeadInbox';
import { getStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Clinical lead' };

export default function Page() {
  return <LeadInbox initial={computeView(getStore().snapshot())} />;
}
