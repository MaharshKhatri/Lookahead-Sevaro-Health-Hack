import type { Metadata } from 'next';
import { clinicalConstants } from '@/server/opener';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Lookahead · Clinical sources' };

const nf = (n: number): string => n.toLocaleString('en-US');

/**
 * /clinical-sources (sprint A3, LOOKAHEAD-DEFINED, illustrative): the source
 * and meaning of every clinical constant used by the impact estimate on
 * /opener and /rewind. Values are read from the engine's clinical constants
 * at render time; nothing here is a clinical outcome measurement.
 */
export default function Page() {
  const c = clinicalConstants();
  const rows: readonly { readonly name: string; readonly value: string; readonly meaning: string }[] = [
    { name: 'Neurons lost per minute', value: nf(c.neuronsPerMin), meaning: 'Average neurons lost per minute of untreated time in a typical large-vessel acute ischemic stroke.' },
    { name: 'Synapses lost per minute', value: nf(c.synapsesPerMin), meaning: 'Average synapses lost per minute of untreated time, same population.' },
    { name: 'Brain aging per minute', value: `${c.agingWeeksPerMin} weeks`, meaning: 'Accelerated brain aging per minute of untreated time, expressed in weeks of normal aging.' },
    { name: 'Delay pass-through ratio', value: `${c.passThroughRatio}:1`, meaning: 'Lookahead assumption: each unassigned stroke consult-minute becomes one minute of treatment delay.' },
  ];
  return (
    <main className="min-h-screen bg-bg text-text">
      <section className="mx-auto w-full max-w-[900px] px-4 py-8 sm:px-8 sm:py-12" data-testid="clinical-sources">
        <div className="text-[13px] font-semibold uppercase tracking-wider text-muted">Lookahead · clinical sources</div>
        <h1 className="mt-4 text-[28px] font-semibold leading-tight sm:text-[34px]">Where the brain-impact estimate comes from</h1>
        <p className="mt-6 text-[17px]">
          Source: <cite data-testid="clinical-citation">{c.citation}</cite>
        </p>
        <p className="mt-3 text-[16px] text-muted">
          The per-minute rates below are published averages for a typical large-vessel acute ischemic stroke. Lookahead multiplies them by the stroke consult-minutes of unassigned delay that the rewind estimates anticipation would have averted.
        </p>
        <table className="mt-6 w-full text-left text-[15px]">
          <thead className="text-[12px] uppercase tracking-wider text-muted">
            <tr>
              <th className="py-2 pr-3">constant</th>
              <th className="py-2 pr-3 text-right">value</th>
              <th className="py-2">meaning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-border align-top">
                <td className="py-2 pr-3 font-semibold">{r.name}</td>
                <td className="num py-2 pr-3 text-right">{r.value}</td>
                <td className="py-2 text-muted">{r.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2 className="mt-8 text-[20px] font-semibold">The 1:1 assumption</h2>
        <p className="mt-2 text-[16px]">
          Unassigned consult time is not the same as treatment delay: a patient may be treated in parallel, or other steps may dominate door-to-needle time. Lookahead assumes a {c.passThroughRatio}:1 pass-through to make the scale of the delay legible. Treat every figure derived from it as an upper-bound illustration.
        </p>
        <h2 className="mt-8 text-[20px] font-semibold">What this is not</h2>
        <p className="mt-2 text-[16px]">
          Extrapolation from published averages applied to a simulated day. Not a clinical outcome measurement. These estimates never feed a routing or staffing decision; the engine decides on operational rules only.
        </p>
        <p className="mt-8 flex gap-6 text-[15px]">
          <a href="/opener" className="text-accent underline">Back to the opener</a>
          <a href="/rewind" className="text-accent underline">Rewind</a>
        </p>
      </section>
    </main>
  );
}
