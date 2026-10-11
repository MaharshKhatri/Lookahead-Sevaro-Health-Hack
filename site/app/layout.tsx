import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';
import './globals.css';

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-plex-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

const description = 'Lookahead rebuilds tele-neurology operations from the raw event stream, sees what is about to break in the next three hours, finds the physician who can fix it, and gets a human’s approval to act.';

export const metadata: Metadata = {
  title: { default: 'Lookahead: see the coverage gap before a stroke patient waits', template: '%s | Lookahead' },
  description,
  openGraph: { title: 'Lookahead', description, type: 'website', siteName: 'Lookahead' },
  twitter: { card: 'summary', title: 'Lookahead', description },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1A1D21' };

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Nav />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
