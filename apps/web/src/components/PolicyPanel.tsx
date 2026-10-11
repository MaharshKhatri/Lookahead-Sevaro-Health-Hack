'use client';

import type { PolicyEntryDTO } from '@/lib/dto';
import { Chip } from './ui';

/** Read-only policy catalog (Phase 7): every forecast / standby / rewind constant with its engine value and whether the brief fixed it. */
export function PolicyPanel({ policy }: { readonly policy: readonly PolicyEntryDTO[] | undefined }) {
  if (policy === undefined) return <p className="p-3 text-muted">Policy catalog not available in this view.</p>;
  if (policy.length === 0) return <p className="p-3 text-muted">No policy constants exported.</p>;
  const sections = [...new Set(policy.map((p) => p.section))];
  return (
    <div data-testid="policy-panel" className="space-y-3 p-3">
      <p className="text-[12px] text-muted">
        Values read from the engine at request time (packages/engine/src/policy.ts). <span className="text-text">BRIEF</span> = fixed by the brief; <span className="text-text">LOOKAHEAD-DEFINED (illustrative)</span> = our default for an open question, logged in docs/DECISIONS.md. The brief&apos;s eligibility numbers (10 h rest, 60 h / 7 d, 1 open offer, 3 / week) appear with their values in the LEDGER chips.
      </p>
      {sections.map((s) => (
        <section key={s}>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{s}</h4>
          <table className="w-full text-left text-[12px]">
            <tbody>
              {policy
                .filter((p) => p.section === s)
                .map((p) => (
                  <tr key={p.name} data-testid="policy-row" className="align-top">
                    <td className="num w-[38%] border-b border-border/60 py-1 pr-2 text-text">{p.name}</td>
                    <td className="num w-[14%] border-b border-border/60 py-1 pr-2 text-accent" title={p.value}>
                      <span className="line-clamp-2 break-all">{p.value}</span>
                    </td>
                    <td className="border-b border-border/60 py-1">
                      <Chip tone={p.source.startsWith('BRIEF') ? 'ok' : p.source.startsWith('OQ') ? 'info' : 'muted'} className="mr-1 normal-case tracking-normal">
                        {p.source.startsWith('BRIEF') ? 'BRIEF' : p.source.startsWith('OQ') ? 'OQ DEFAULT' : 'LOOKAHEAD-DEFINED'}
                      </Chip>
                      <span className="text-muted">{p.source.startsWith('BRIEF') || p.source.startsWith('OQ') ? `${p.source}: ` : ''}{p.note}</span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
