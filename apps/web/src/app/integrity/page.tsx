import { IntegrityView } from '@/components/IntegrityView';
import { getStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <IntegrityView initial={computeView(getStore().snapshot())} />;
}
