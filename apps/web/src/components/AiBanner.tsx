import Link from 'next/link';

/**
 * Sprint A4: one thin line under the patient clock on every page. States the
 * product rule (CLAUDE.md: LLMs are never in the decision path; they only
 * narrate engine-computed facts) and links to the architecture page.
 */
export function AiBanner() {
  return (
    <div data-testid="ai-banner" className="flex items-center gap-2 border-b border-border bg-panel px-3 py-0.5 text-[11px] text-muted">
      <span>
        <span className="font-semibold text-text">AI narrates. Humans decide.</span> Every number and recommendation comes from the rules engine; a human approves every action.
      </span>
      <Link href="/architecture" className="ml-auto shrink-0 text-info underline">
        How it works
      </Link>
    </div>
  );
}
