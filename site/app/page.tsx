import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { HorizonReplay } from '@/components/HorizonReplay';
import { LinkButton, Section } from '@/components/Section';
import { facts, ledger, links, saver, scenario, trap } from '@/content/facts';
import commandCenter from '@/public/screens/command-center.png';
import opener from '@/public/screens/opener.png';
import rewind from '@/public/screens/rewind.png';

const description = 'Lookahead rebuilds Sevaro’s operations from the raw event stream, sees what’s about to break in the next three hours, finds the one physician who can fix it, and gets a human’s approval to act.';

export const metadata: Metadata = {
  title: { absolute: 'Lookahead: see the coverage gap before a stroke patient waits' },
  description,
  openGraph: { title: 'Lookahead', description, type: 'website' },
  twitter: { card: 'summary', title: 'Lookahead', description },
};

const fmt = new Intl.NumberFormat('en-US');
const oak = scenario.oakValley;
const sun = scenario.suncrest;
const rec = scenario.recommendation;

function Hero() {
  const buttons = [
    links.video === null ? null : { href: links.video, label: 'Watch the 5-minute demo' },
    links.demo === null ? null : { href: links.demo, label: 'Open the live product' },
    links.repo === null ? null : { href: links.repo, label: 'Read the code' },
  ].filter((b): b is { href: string; label: string } => b !== null);
  return (
    <div className="mx-auto max-w-[1200px] px-5 pb-16 pt-14 sm:px-8 sm:pt-20">
      <h1 className="max-w-[18ch] text-[36px] font-semibold leading-[1.08] tracking-tight sm:text-[60px]">See the coverage gap before a stroke patient waits.</h1>
      <p className="mt-6 max-w-[62ch] text-[17px] text-ink-2 sm:text-[19px]">{description}</p>
      {buttons.length > 0 && (
        <div className="mt-8 flex flex-wrap gap-3">
          {buttons.map((b, i) => (
            <LinkButton key={b.label} href={b.href} primary={i === 0}>
              {b.label}
            </LinkButton>
          ))}
        </div>
      )}
      <div className="mt-12">
        <HorizonReplay />
      </div>
    </div>
  );
}

function Problem() {
  const rows = [
    { where: oak.hospital, when: oak.triaged, mark: 'alarm' as const, text: `Stroke consult triaged at ${oak.triaged}. Routing failed at ${oak.routingFailures.join(', ')} because ${oak.why}.` },
    { where: sun.hospital, when: sun.strokeTriaged, mark: 'caution' as const, text: `${sun.lastHourConsults} consults in the last hour against a normal p90 of ${sun.normalP90}. A stroke consult triaged at ${sun.strokeTriaged} failed routing at ${sun.routingFailure}.` },
    { where: 'Network', when: `${scenario.shiftEnds.at}:00`, mark: 'caution' as const, text: `${scenario.shiftEnds.physicians} physicians end their shifts at ${scenario.shiftEnds.at} ${scenario.shiftEnds.note}.` },
  ];
  return (
    <Section id="problem" title="Sevaro already sees who’s busy. What’s missing is what happens next.">
      <p>
        At {scenario.now} ET on {scenario.date}, three things are already in motion. Each is visible on its own. Together they mean a stroke consult will wait unless someone acts now.
      </p>
      <ol className="mt-2 space-y-0 border-l border-rule">
        {rows.map((r) => (
          <li key={r.where} className="relative py-3 pl-6">
            <span aria-hidden="true" className={`absolute -left-[5px] top-[22px] h-[9px] w-[9px] rotate-45 ${r.mark === 'alarm' ? 'bg-alarm' : 'bg-caution'}`} />
            <p className="text-[15px] text-ink">
              <span className="font-mono text-ink-2">{r.when}</span> <span className="font-semibold">{r.where}</span>
            </p>
            <p className="mt-0.5">{r.text}</p>
          </li>
        ))}
      </ol>
      <p className="text-[15px]">{saver.line}</p>
    </Section>
  );
}

function HowItWorks() {
  const steps = [
    { name: 'Detect', concrete: `Oak Valley’s stroke consult has failed routing three times, and nobody credentialed there is free.`, technical: `Replays ${fmt.format(facts.events)} raw events in knowledge time and reproduces the routing rules, stage timers and coverage requirements.` },
    { name: 'Forecast', concrete: `Suncrest is running at ${sun.lastHourConsults} consults an hour against a normal ${sun.normalP90}, and ${scenario.shiftEnds.physicians} physicians leave at ${scenario.shiftEnds.at}.`, technical: 'Surge probabilities per hospital from the time-of-day baseline, today’s rate and recent arrivals, each with its drivers explained.' },
    { name: 'Decide', concrete: `${rec.physician} is the one off-shift physician who passes every rule, for ${rec.window}.`, technical: `Checks all ${facts.offShiftPhysicians} off-shift physicians against every eligibility rule and scopes the offer to avoid the split-shift trap.` },
    { name: 'Act', concrete: 'The coordinator proposes, the clinical lead approves, and the physician accepts on the phone.', technical: 'An append-only action log. Every message passes a patient-information check and every step is audited.' },
  ];
  return (
    <Section id="how" title="How it works" wide>
      <ol className="grid gap-x-10 gap-y-10 md:grid-cols-2">
        {steps.map((s, i) => (
          <li key={s.name} className="max-w-[60ch]">
            <p className="text-[20px] font-semibold">
              <span className="mr-2 tabular-nums text-ink-2">{i + 1}</span>
              {s.name}
            </p>
            <p className="mt-2 text-[17px] text-ink">{s.concrete}</p>
            <p className="mt-1 text-[15px] text-ink-2">{s.technical}</p>
          </li>
        ))}
      </ol>
      <p className="mt-10 text-[17px]">
        <Link href="/how-it-works" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink">
          The full pipeline, the forecast model card and the FAQ
        </Link>
      </p>
    </Section>
  );
}

function Product() {
  const shots = [
    { img: commandCenter, alt: 'The Lookahead command center at 18:20: the stroke-unassigned band at the top, the Horizon Line, the ranked attention list, the coverage grid and the next best actions.', caption: 'The command center at 18:20. The band at the top names the stroke consult that has waited longest; the Horizon Line shows the next three hours.' },
    { img: opener, alt: 'The opener page: three sentences describing what Lookahead would have done earlier that day, with a timeline.', caption: 'The opener replays the day as if Lookahead had been running, using the same engine.' },
    { img: rewind, alt: 'The rewind page: estimated impact and the gap probabilities per hospital across the afternoon, with a time slider.', caption: 'Rewind compares what happened with what a reactive and an anticipatory Lookahead would have done.' },
  ];
  return (
    <Section id="product" title="The product" wide>
      <div className="space-y-12">
        {shots.map((s) => (
          <figure key={s.caption}>
            <Image src={s.img} alt={s.alt} className="h-auto w-full rounded-[8px] border border-rule" sizes="(min-width: 1200px) 1136px, 100vw" placeholder="empty" />
            <figcaption className="mt-3 max-w-[72ch] text-[15px] text-ink-2">{s.caption}</figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}

function Ledger() {
  return (
    <Section id="ledger" title="Who can cover it" wide>
      <p className="max-w-[72ch] text-[17px] text-ink-2">
        All {facts.offShiftPhysicians} off-shift physicians, checked against every rule for the gap at Suncrest, Northfield and Oak Valley.
      </p>
      <div className="mt-6 overflow-x-auto rounded-[4px] border border-rule">
        <table className="w-full min-w-[560px] border-collapse text-left text-[15px]">
          <caption className="sr-only">Eligibility ledger for the 18:35 to 22:35 offer</caption>
          <thead className="bg-surface text-ink-2">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Physician</th>
              <th scope="col" className="px-4 py-3 font-medium">Verdict</th>
              <th scope="col" className="px-4 py-3 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((r) => (
              <tr key={r.name} className={r.eligible ? 'border-t border-rule bg-action/10' : 'border-t border-rule'}>
                <th scope="row" className={`px-4 py-3 font-medium ${r.eligible ? 'border-l-2 border-action text-ink' : 'border-l-2 border-transparent text-ink'}`}>
                  {r.name}
                </th>
                <td className={`px-4 py-3 ${r.eligible ? 'font-semibold text-action' : 'text-ink-2'}`}>{r.eligible ? 'Eligible' : 'Not eligible'}</td>
                <td className={`px-4 py-3 ${r.eligible ? 'text-ink' : 'text-caution'}`}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-6 max-w-[72ch] text-[17px] text-ink-2">{trap.text}</p>
    </Section>
  );
}

function Standby() {
  const states = [
    { name: 'Pre-alert', text: 'Before a forecast surge, a likely-eligible off-shift physician is asked to be reachable. No commitment yet.' },
    { name: '“I can be ready”', text: 'The physician answers from the phone. Saying no is one tap and costs nothing.' },
    { name: 'Activation', text: 'When the gap becomes likely, the coordinator proposes activation for the hospitals at risk.' },
    { name: 'Online or released', text: 'The physician comes online, scoped to the gap hospitals, or is released with thanks when the risk fades.' },
  ];
  return (
    <Section id="standby" title="Standby network: line someone up before the gap opens" wide>
      <ol className="grid gap-6 md:grid-cols-4">
        {states.map((s, i) => (
          <li key={s.name} className="border-t-2 border-rule pt-4">
            <p className="text-[17px] font-semibold">
              <span className="mr-2 tabular-nums text-ink-2">{i + 1}</span>
              {s.name}
            </p>
            <p className="mt-2 text-[15px] text-ink-2">{s.text}</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 max-w-[72ch] text-[17px] text-ink-2">Every message to an off-shift physician, at every step, needs the clinical lead’s approval first.</p>
      {facts.rewind !== null && (
        <p className="mt-4 max-w-[72ch] text-[17px] text-ink">
          Replaying this day with the standby network on, the Oak Valley stroke consult would have waited <span className="font-semibold text-action">{facts.rewind.anticipatoryWaitMin} min</span> instead of <span className="font-semibold text-alarm">{facts.rewind.actualWaitMin} min</span> (counted to 19:20, when the data ends). Across the day, anticipation averts {facts.rewind.strokeMinutesAverted} stroke consult-minutes of waiting.
        </p>
      )}
    </Section>
  );
}

function AiHumans() {
  return (
    <Section id="ai" title="AI narrates. Humans decide." wide>
      <div className="grid gap-10 md:grid-cols-2">
        <div>
          <h3 className="text-[19px] font-semibold">What AI does</h3>
          <ul className="mt-3 space-y-2 text-[17px] text-ink-2">
            <li>Turns facts the engine computed into plain sentences: why a hospital is at risk, why this physician.</li>
            <li>Drafts wording for people to read. A fidelity guard rejects any number, time or name that is not in the facts.</li>
          </ul>
        </div>
        <div>
          <h3 className="text-[19px] font-semibold">What AI never does</h3>
          <ul className="mt-3 space-y-2 text-[17px] text-ink-2">
            <li>Pick the physician to call or the standby to pre-alert.</li>
            <li>Send any message without a person’s approval.</li>
            <li>Change consult or physician state.</li>
          </ul>
        </div>
      </div>
      <p className="mt-8 max-w-[72ch] text-[17px] text-ink">Every decision comes from a deterministic, tested engine, so it can be explained, audited and reversed.</p>
    </Section>
  );
}

function Proof() {
  const figures = [
    { value: `${facts.snapshotMatch.physicians} and ${facts.snapshotMatch.consults}`, label: 'physicians and consults match the reference snapshot at 18:20' },
    { value: facts.routingFailuresReproduced, label: 'routing failures in the stream reproduced by the routing rules' },
    { value: fmt.format(facts.events), label: `events replayed, including one ${facts.lateEvent.lateSeconds} seconds late and ${facts.duplicateEvents} duplicate` },
    facts.testCount === null ? null : { value: fmt.format(facts.testCount), label: 'automated engine and web tests, all passing' },
    facts.scale === null ? null : { value: `${fmt.format(facts.scale.hospitals)} hospitals`, label: `in a 20× synthetic network: one full uncached recompute takes ${(facts.scale.totalMs / 1000).toFixed(1)} s (measured)` },
  ].filter((f): f is { value: string; label: string } => f !== null);
  return (
    <Section id="proof" title="Proof, not promises" wide>
      <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {figures.map((f) => (
          <div key={f.label} className="border-t border-rule pt-4">
            <dt className="sr-only">{f.label}</dt>
            <dd className="text-[30px] font-semibold tabular-nums tracking-tight">{f.value}</dd>
            <dd className="mt-1 max-w-[36ch] text-[15px] text-ink-2">{f.label}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function PlugIn() {
  return (
    <Section id="plug-in" title="Built to plug in">
      <p>Events arrive as a signed, idempotent stream. Results go back out as webhooks and a read API.</p>
      <p>A shadow-mode rollout runs Lookahead read-only first, then advisory, then as a closed loop with approvals.</p>
      <p>Nothing changes upstream: reassignments are requests a person carries out in the system of record.</p>
      <p>
        <Link href="/integration" className="text-ink underline decoration-rule underline-offset-4 hover:decoration-ink">
          How Lookahead fits next to Sevaro’s platform
        </Link>
      </p>
    </Section>
  );
}

function Team() {
  return (
    <Section id="team" title="Team">
      <p>Two computer science and two pre-med students at Rutgers. Engineering and clinical judgment in the same room.</p>
      {facts.team !== null && facts.team.length > 0 && <p className="text-ink">{facts.team.join(', ')}</p>}
    </Section>
  );
}

export default function Home() {
  return (
    <>
      <Hero />
      <Problem />
      <HowItWorks />
      <Product />
      <Ledger />
      <Standby />
      <AiHumans />
      <Proof />
      <PlugIn />
      <Team />
    </>
  );
}
