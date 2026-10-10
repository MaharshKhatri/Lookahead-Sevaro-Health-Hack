import type { Metadata } from 'next';
import { AdminDataset } from '@/components/AdminDataset';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Dataset' };

export default async function Page() {
  return <AdminDataset initial={computeView((await getReadyStore()).snapshot())} />;
}
