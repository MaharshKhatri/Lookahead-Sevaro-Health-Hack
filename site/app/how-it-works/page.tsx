import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { facts } from '@/content/facts';

const description = 'The Lookahead pipeline from raw events to an audited action: knowledge-time replay, availability, breaches, the surge forecast, eligibility, the standby network and human approval.';

export const metadata: Metadata = {
  title: 'How it works',
  description,
  openGraph: { title: 'How Lookahead works', description, type: 'article' },
  twitter: { card: 'summary', title: 'How Lookahead works', description },
};

const fmt = new Intl.NumberFormat('en-US');

const PIPELINE = [
  { name: 'Raw events', text: `The ${fmt.format(facts.events)} events of the evening: calls, video sessions, status changes, camera and presence signals, assignments and notes.` },
  { name: 'Knowledge-time replay', text: 'State is rebuilt from what was known at each instant, in the order things happened. A duplicate is applied once.' },
  { name: 'Availability inference', text: 'Physician state is inferred from signals, not taken from self-reported status alone. A camera on with no session counts as busy and is flagged.' },
  { name: 'Breach detection', text: 'Each consult stage is timed against the operational standards, so a breach is caught at the minute it happens.' },
  { name: 'Surge forecast', text: 'For each hospital, the probability that demand rises above its normal level in the coming hours, with the reasons.' },
  { name: 'Coverage projection', text: 'Who will be routable at each hospital as shifts end and start, so a gap is seen before it opens.' },
  { name: 'Eligibility', text: 'Every off-shift physician is checked against every rule: opt-in, credentials at the gap hospitals, rest, weekly hours, schedule overlap and offer limits.' },
  { name: 'Standby network', text: 'Before a likely gap, an eligible physician can be asked to be ready, then activated or released.' },
  { name: 'Human approval', text: 'The coordinator proposes and the clinical lead approves the exact message before anything is sent.' },
  { name: 'Audited action', text: 'Every step goes into an append-only log with who acted, in what role, and when.' },
];

const FAQ = [
  { q: 'Did you hard-code the answers?', a: 'No. A test renames every physician, hospital, consult and event ID, shifts every time and shuffles the rows. The engine reaches the same verdicts on the mutated package.' },
  { q: 'Is AI making decisions?', a: 'No. A deterministic engine makes every recommendation, and a person approves every action. A language model only puts computed facts into sentences.' },
  { q: 'What about patient information?', a: 'Messages to physicians carry hospitals, hours and a start time only. An automated check runs on every message when it is drafted and again when it is sent.' },
  { q: 'What if a physician declines?', a: 'An offer expires after 10 minutes. Lookahead then suggests the next eligible physician, or escalation to the clinical lead when nobody else is eligible.' },
  { q: 'What if two physicians accept at once?', a: 'Exactly one wins. Acceptance is a single atomic write, so the second is told the gap is already filled.' },
  { q: 'How would this integrate?', a: 'Through a signed event API, outbound webhooks and a shadow-mode rollout that starts read-only.' },
];

export default function HowItWorks() {
  return (
    <>
      <div className="mx-auto max-w-[1200px] px-5 pb-14 pt-14 sm:px-8 sm:pt-20">
        <h1 className="max-w-[20ch] text-[36px] font-semibold leading-[1.1] tracking-tight sm:text-[52px]">From raw events to an approved action.</h1>
        <p className="mt-6 max-w-[64ch] text-[17px] text-ink-2 sm:text-[19px]">Ten steps. Every computed step is deterministic and tested, and the same engine runs on the live stream and on the replayed day.</p>
      </div>

      <Section id="pipeline" title="The pipeline" wide>
        <ol className="grid max-w-[900px] gap-y-6">
          {PIPELINE.map((p, i) => (
            <li key={p.name} className="grid grid-cols-[2.5rem_1fr] gap-x-3 border-t border-rule pt-4">
              <span className="text-[17px] tabular-nums text-ink-2">{i + 1}</span>
              <div>
                <p className="text-[17px] font-semibold text-ink">{p.name}</p>
                <p className="mt-1 max-w-[72ch] text-[17px] text-ink-2">{p.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="knowledge-time" title="Knowledge time, with a real late event">
        <p>
          The data has {facts.lateEvent.description}. It arrived {facts.lateEvent.lateSeconds} seconds late. A system that applies events as they arrive would have shown the wrong stage for those minutes and started the timer from the wrong point.
        </p>
        <p>Lookahead orders events by when they happened and only uses what was known at each instant, so the timeline is correct after the fact and never peeks at the future.</p>
        <p>The data also carries {facts.duplicateEvents} duplicate event. It is applied once.</p>
      </Section>

      <Section id="forecast" title="Forecast model card" wide>
        <dl className="grid max-w-[900px] gap-x-10 gap-y-6 md:grid-cols-2">
          <div>
            <dt className="text-[17px] font-semibold text-ink">What it uses</dt>
            <dd className="mt-1 text-[17px] text-ink-2">The hospital’s time-of-day baseline, today’s rate so far, and recent arrivals, which can cluster.</dd>
          </div>
          <div>
            <dt className="text-[17px] font-semibold text-ink">What it outputs</dt>
            <dd className="mt-1 text-[17px] text-ink-2">Probabilities, such as the chance that demand exceeds the normal level in the next hour, with the drivers behind each number.</dd>
          </div>
          <div>
            <dt className="text-[17px] font-semibold text-ink">How it is checked</dt>
            <dd className="mt-1 text-[17px] text-ink-2">
              A rolling backtest against two simple baselines: the time-of-day average and “the next hour looks like the last one”.
              {facts.backtestHeadline !== null && <> On this one synthetic day it beat the persistence baseline on 4 of 5 metrics and did not beat the time-of-day baseline on any. The report says it plainly: “{facts.backtestHeadline}”</>}
            </dd>
          </div>
          <div>
            <dt className="text-[17px] font-semibold text-ink">Limits</dt>
            <dd className="mt-1 text-[17px] text-ink-2">One synthetic day of data. In production the model would learn from Sevaro’s history before anyone relied on it.</dd>
          </div>
        </dl>
      </Section>

      <Section id="why-not-agent" title="Why not an AI agent?">
        <p>An operations decision has to be explainable, auditable and reversible, and it has to come out the same way every time from the same facts. A deterministic engine does that; a free-running agent does not.</p>
        <p>AI has one job here: it narrates facts the engine already computed, behind a fidelity guard that rejects any number, time or name that is not in those facts.</p>
      </Section>

      <Section id="faq" title="Questions we get" wide>
        <dl className="max-w-[900px] divide-y divide-rule border-y border-rule">
          {FAQ.map((f) => (
            <div key={f.q} className="py-5">
              <dt className="text-[17px] font-semibold text-ink">{f.q}</dt>
              <dd className="mt-1 max-w-[72ch] text-[17px] text-ink-2">{f.a}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
