import type { Metadata } from 'next';
import { OpenerContent } from '@/components/Opener';
import { Testimonial } from '@/components/Testimonial';
import { openerFor } from '@/server/opener';
import { getReadyStore } from '@/server/store';
import { testimonial } from '@/server/testimonial';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Opener' };

/** /opener (sprint A1, LOOKAHEAD-DEFINED): the single most impactful rewind episode, projector and phone friendly. */
export default async function Page() {
  const s = (await getReadyStore()).snapshot();
  return (
    <main className="min-h-screen bg-bg text-text">
      <OpenerContent data={openerFor(s)} />
      <div className="mx-auto w-full max-w-[1000px] px-4 pb-10 sm:px-8">
        <Testimonial value={testimonial()} />
      </div>
    </main>
  );
}
