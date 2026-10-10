import { StateView } from '@/components/StateView';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return <StateView initial={computeView((await getReadyStore()).snapshot())} />;
}
