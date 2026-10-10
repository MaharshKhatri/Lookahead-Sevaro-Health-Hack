import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { LeadInbox } from '@/components/LeadInbox';
import { LeadPinGate } from '@/components/LeadPinGate';
import { LEAD_COOKIE, isLeadCookieValue } from '@/server/auth';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Clinical lead' };

/** Clinical lead inbox; behind the shared lead PIN (OQ-44). */
export default async function Page() {
  if (!isLeadCookieValue((await cookies()).get(LEAD_COOKIE)?.value)) return <LeadPinGate />;
  return <LeadInbox initial={computeView((await getReadyStore()).snapshot())} />;
}
