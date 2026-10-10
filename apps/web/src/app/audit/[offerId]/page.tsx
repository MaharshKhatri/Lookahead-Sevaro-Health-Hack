import { auditTrail } from '@lookahead/engine';
import { AuditView } from '@/components/AuditView';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const id = decodeURIComponent(offerId);
  const s = (await getReadyStore()).snapshot();
  return <AuditView initial={computeView(s)} offerId={id} trail={auditTrail(s.log, id, s.clock.nowMs)} />;
}
