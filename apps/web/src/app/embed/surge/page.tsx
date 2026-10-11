import type { Metadata } from 'next';
import { EmbedSurge } from '@/components/EmbedSurge';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Surge radar (embed)' };

const DEFAULT_LIMIT = 6;

/** /embed/surge?limit=N: the Surge Radar for an iframe (D-96); frame-ancestors from LOOKAHEAD_EMBED_ORIGINS via middleware. */
export default async function Page({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const raw = Number(Array.isArray(q.limit) ? q.limit[0] : q.limit);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 50) : DEFAULT_LIMIT;
  const s = (await getReadyStore()).snapshot();
  return <EmbedSurge initial={computeView(s)} limit={limit} />;
}
