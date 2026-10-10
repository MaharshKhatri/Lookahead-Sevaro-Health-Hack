import type { Metadata } from 'next';
import { PhoneOffer } from '@/components/PhoneOffer';
import { publicOffer } from '@/server/offers';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Split-shift offer' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const offerId = decodeURIComponent(id);
  return <PhoneOffer offerId={offerId} initial={publicOffer(getStore().snapshot(), offerId)} />;
}
