import type { Metadata } from 'next';
import { PhoneOffer } from '@/components/PhoneOffer';
import { verifyOfferToken } from '@/server/auth';
import { publicOffer } from '@/server/offers';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Split-shift offer' };

/** The physician's phone view; only valid with the link token from the delivered offer (OQ-44). */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string | string[] }> }) {
  const { id } = await params;
  const { t } = await searchParams;
  const offerId = decodeURIComponent(id);
  const token = typeof t === 'string' && verifyOfferToken(offerId, t) ? t : null;
  const initial = token === null ? null : publicOffer((await getReadyStore()).snapshot(), offerId);
  return <PhoneOffer offerId={offerId} token={token} initial={initial} />;
}
