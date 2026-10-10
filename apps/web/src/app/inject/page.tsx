import { InjectView } from '@/components/InjectView';
import { getStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <InjectView initial={computeView(getStore().snapshot())} />;
}
