import type { Metadata } from 'next';
import { QualityView } from '@/components/QualityView';
import { readBacktest } from '@/server/quality';
import { getReadyStore } from '@/server/store';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Forecast quality' };

/** /quality: the forecast backtest (Phase 3, D-89) from docs/forecast_backtest.json; every number comes from the report. */
export default async function Page() {
  const s = (await getReadyStore()).snapshot();
  return <QualityView initial={computeView(s)} report={readBacktest()} />;
}
