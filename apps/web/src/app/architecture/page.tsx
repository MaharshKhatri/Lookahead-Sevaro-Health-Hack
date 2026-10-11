import type { Metadata } from 'next';
import { Architecture } from '@/components/Architecture';
import { ARCHITECTURE_MERMAID, architectureReport } from '@/server/architecture';
import { SCALE_TEST_DEFAULT_FACTOR } from '@/server/scaleTest';
import { getReadyStore } from '@/server/store';
import { testimonial } from '@/server/testimonial';
import { computeView } from '@/server/view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Architecture' };

/** /architecture (sprint A4/B3): the AI boundary, the pipeline, live action-log counters, request-time badges and the live scale test. */
export default async function Page() {
  const s = (await getReadyStore()).snapshot();
  return <Architecture initialView={computeView(s)} initial={architectureReport(s)} mermaid={ARCHITECTURE_MERMAID} testimonial={testimonial()} scaleFactor={SCALE_TEST_DEFAULT_FACTOR} />;
}
