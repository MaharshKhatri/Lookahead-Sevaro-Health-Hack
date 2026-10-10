import { IntegrityView } from '@/components/IntegrityView';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return <IntegrityView initial={computeView((await getReadyStore()).snapshot())} />;
}
