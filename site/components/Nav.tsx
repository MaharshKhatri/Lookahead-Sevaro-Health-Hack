import Link from 'next/link';
import { links } from '@/content/facts';
import { Mark } from './Mark';

const NAV = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/integration', label: 'Integration' },
  { href: '/#proof', label: 'Proof' },
] as const;

export function Nav() {
  return (
    <header className="border-b border-rule">
      <nav aria-label="Main" className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 sm:px-8">
        <Link href="/" className="flex items-center gap-2 text-[19px] font-semibold tracking-tight text-ink">
          <Mark />
          Lookahead
        </Link>
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[15px] text-ink-2">
          {NAV.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="hover:text-ink">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        {links.demo !== null && (
          <a href={links.demo} className="ml-auto rounded-[4px] border border-action px-3 py-1.5 text-[15px] font-medium text-action hover:bg-action hover:text-ground">
            Open the live product
          </a>
        )}
      </nav>
    </header>
  );
}
