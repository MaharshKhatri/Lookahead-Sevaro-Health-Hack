import { StateView } from '@/components/StateView';
import { getStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <StateView initial={computeView(getStore().snapshot())} />;
}
