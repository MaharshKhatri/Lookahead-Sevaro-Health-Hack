import type { Metadata } from 'next';
import { ArchitectureDiagram } from '@/components/ArchitectureDiagram';
import { Section } from '@/components/Section';

const description = 'How Lookahead sits next to Sevaro’s platform: a signed, idempotent event API, outbound webhooks, an embeddable view, approvals by role and messages with no patient information.';

export const metadata: Metadata = {
  title: 'Integration',
  description,
  openGraph: { title: 'Lookahead integration', description, type: 'article' },
  twitter: { card: 'summary', title: 'Lookahead integration', description },
};

export default function Integration() {
  return (
    <>
      <div className="mx-auto max-w-[1200px] px-5 pb-14 pt-14 sm:px-8 sm:pt-20">
        <h1 className="max-w-[22ch] text-[36px] font-semibold leading-[1.1] tracking-tight sm:text-[52px]">Built to extend Sevaro’s platform, not replace it.</h1>
        <p className="mt-6 max-w-[64ch] text-[17px] text-ink-2 sm:text-[19px]">
          Lookahead reads events in the format of Sevaro’s challenge data, and it never writes upstream. A reassignment is a request a person carries out in the system of record.
        </p>
        <div className="mt-10 overflow-x-auto rounded-[4px] border border-rule bg-surface p-4">
          <ArchitectureDiagram />
        </div>
      </div>

      <Section id="ingest" title="Event ingestion">
        <p>Events come in three ways: the CSV data package, an HTTP push, or a signed event API.</p>
        <p>The API takes rows as CSV text or JSON keyed by the same column names. Each body carries an HMAC-SHA256 signature, and each event is idempotent on its event ID, so a retried push is reported as a duplicate and never applied twice.</p>
        <p>Late events are ordered by when they happened, not when they arrived.</p>
      </Section>

      <Section id="webhooks" title="Outbound webhooks">
        <p>When state changes, Lookahead posts a signed envelope to a configured URL. The envelope carries no clinical content, only what changed and where to read it, so existing tools pull the current state from the read API.</p>
      </Section>

      <Section id="embed" title="Embed mode">
        <p>The surge radar can be embedded on its own in another dashboard. Framing is allowed only from origins the operator lists.</p>
      </Section>

      <Section id="shadow" title="A rollout in three phases">
        <p>This is how we would introduce Lookahead to a live operation. The prototype runs on synthetic data and does not include the read-only mode.</p>
        <ol className="list-decimal space-y-2 pl-6 marker:text-ink-2">
          <li>
            <span className="text-ink">Read-only.</span> Lookahead watches the live stream and records what it would have recommended. Nobody acts on it.
          </li>
          <li>
            <span className="text-ink">Advisory.</span> Coordinators see the recommendations and act through their usual tools.
          </li>
          <li>
            <span className="text-ink">Closed loop, with approvals.</span> Coordinators propose in Lookahead, the clinical lead approves, and the physician answers on the phone.
          </li>
        </ol>
      </Section>

      <Section id="roles" title="Roles and approvals">
        <p>The coordinator proposes. The clinical lead approves every message to an off-shift physician, with a PIN, after seeing the exact text. The physician answers from a signed link that only they received.</p>
        <p>The rules are enforced on the server, not just hidden in the interface.</p>
      </Section>

      <Section id="phi" title="Messages without patient information">
        <p>A message to a physician carries hospitals, hours and a start time, nothing about a case. Every message passes an automated check when it is drafted and again when it is sent.</p>
      </Section>

      <Section id="deploy" title="Deployment">
        <p>One Next.js server runs the engine on EC2. The action log can live in DynamoDB, where a conditional write makes a double acceptance impossible. Bedrock only writes narration, behind a guard that checks every number and name. The audit trail is archived to S3.</p>
        <p>Every AWS service falls back to a local path, so the system keeps working when one is unreachable.</p>
      </Section>

      <Section id="seams" title="Integration seams">
        <p className="text-ink">Synapse AI as the event and schedule source; OneCall as the routing seam; the Triage app as the physician push channel.</p>
        <p>Based on Sevaro’s public product descriptions. We have not seen Sevaro’s APIs.</p>
      </Section>
    </>
  );
}
