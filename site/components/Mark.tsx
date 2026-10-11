/** The brand mark: a horizon line with the "now" edge. Teal is reserved for Lookahead itself. */
export function Mark({ size = 22 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <line x1="2" y1="15" x2="9" y2="15" stroke="var(--color-ink-3)" strokeWidth="2" strokeLinecap="round" />
      <line x1="9" y1="15" x2="22" y2="15" stroke="var(--color-action)" strokeWidth="2" strokeLinecap="round" />
      <line x1="9" y1="5" x2="9" y2="20" stroke="var(--color-ink)" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M15 15 L15 8 L20 9.5 L15 11" fill="var(--color-action)" />
    </svg>
  );
}
