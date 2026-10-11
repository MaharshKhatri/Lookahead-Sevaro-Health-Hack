import { CommandCenter } from '@/components/CommandCenter';
import { OpenerModal } from '@/components/Opener';
import { openerFor } from '@/server/opener';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

/**
 * Server-rendered first paint (no loading flash on the projector); the client then follows /api/stream.
 * /?opener=1 (sprint A1) overlays the dismissible opener on the Command Center.
 */
export default async function Page({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const s = (await getReadyStore()).snapshot();
  return (
    <>
      <CommandCenter initial={computeView(s)} />
      {sp.opener === '1' && <OpenerModal data={openerFor(s)} />}
    </>
  );
}
