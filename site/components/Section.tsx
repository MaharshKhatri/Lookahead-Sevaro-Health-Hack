import type { ReactNode } from 'react';

/** A page section: 1 px rule above, a left-aligned heading, body text capped at 72 characters. */
export function Section({ id, title, children, wide = false }: { readonly id?: string; readonly title: string; readonly children: ReactNode; readonly wide?: boolean }) {
  return (
    <section id={id} aria-labelledby={id === undefined ? undefined : `${id}-title`} className="border-t border-rule">
      <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8 sm:py-20">
        <h2 id={id === undefined ? undefined : `${id}-title`} className="max-w-[28ch] text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
          {title}
        </h2>
        <div className={wide ? 'mt-8' : 'mt-6 max-w-[72ch] space-y-4 text-[17px] text-ink-2'}>{children}</div>
      </div>
    </section>
  );
}

export function LinkButton({ href, children, primary = false }: { readonly href: string; readonly children: ReactNode; readonly primary?: boolean }) {
  return (
    <a href={href} className={primary ? 'inline-flex min-h-11 items-center rounded-[4px] bg-action px-4 text-[16px] font-medium text-ground hover:brightness-110' : 'inline-flex min-h-11 items-center rounded-[4px] border border-rule px-4 text-[16px] font-medium text-ink hover:border-ink-3'}>
      {children}
    </a>
  );
}
