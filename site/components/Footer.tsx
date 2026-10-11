import Link from 'next/link';
import { disclaimer, links } from '@/content/facts';

export function Footer() {
  return (
    <footer className="mt-24 border-t border-rule">
      <div className="mx-auto max-w-[1200px] space-y-4 px-5 py-10 text-[15px] text-ink-2 sm:px-8">
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          <li>
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
          </li>
          <li>
            <Link href="/how-it-works" className="hover:text-ink">
              How it works
            </Link>
          </li>
          <li>
            <Link href="/integration" className="hover:text-ink">
              Integration
            </Link>
          </li>
          {links.repo !== null && (
            <li>
              <a href={links.repo} className="hover:text-ink">
                Source code
              </a>
            </li>
          )}
        </ul>
        <p className="max-w-[72ch]">{disclaimer}</p>
      </div>
    </footer>
  );
}
