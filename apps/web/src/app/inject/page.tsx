import { InjectView } from '@/components/InjectView';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  return <InjectView initial={computeView((await getReadyStore()).snapshot())} />;
}
