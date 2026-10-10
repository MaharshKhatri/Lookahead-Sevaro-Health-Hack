import { CommandCenter } from '@/components/CommandCenter';
import { getStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

/** Server-rendered first paint (no loading flash on the projector); the client then follows /api/stream. */
export default function Page() {
  return <CommandCenter initial={computeView(getStore().snapshot())} />;
}
