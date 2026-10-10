import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// Self-hosted fonts (no network at build time): IBM Plex Sans for UI, Plex Mono for IDs/times/numbers.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lookahead',
  description: 'Tele-neurology operations command center: detect, decide, act.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0B1320',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-text antialiased">{children}</body>
    </html>
  );
}
