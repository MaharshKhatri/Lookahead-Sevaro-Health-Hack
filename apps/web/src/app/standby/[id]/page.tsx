import type { Metadata } from 'next';
import { PhoneStandby } from '@/components/PhoneStandby';
import { verifyStandbyToken } from '@/server/auth';
import { publicStandby } from '@/server/standby';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Standby' };

/** The physician's phone view of a standby pre-alert / activation; only valid with the link token (OQ-44). */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string | string[] }> }) {
  const { id } = await params;
  const { t } = await searchParams;
  const standbyId = decodeURIComponent(id);
  const token = typeof t === 'string' && verifyStandbyToken(standbyId, t) ? t : null;
  const initial = token === null ? null : publicStandby((await getReadyStore()).snapshot(), standbyId);
  return <PhoneStandby standbyId={standbyId} token={token} initial={initial} />;
}
