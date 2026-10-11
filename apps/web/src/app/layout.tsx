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
import { TopChrome } from '@/components/PatientClockHeader';
import { SystemStatusPill } from '@/components/StatusPill';
import { CommandPalette } from '@/ui/CommandPalette';
import { ShortcutsSheet } from '@/ui/ShortcutsSheet';
import { ThemeKeys } from '@/ui/theme';
import { THEME_SCRIPT } from '@/ui/themeScript';

export const metadata: Metadata = {
  title: 'Lookahead',
  description: 'Tele-neurology operations command center: detect, decide, act.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0B1320',
};

/**
 * Sprint A2/A4/A6 chrome: the patient clock and AI banner sit above every page
 * (TopChrome publishes its height as --chrome-h) and the status pill is fixed
 * bottom-right. Full-viewport pages built with `h-screen` (console, state,
 * integrity, inject, admin, audit, quality, rewind, architecture) are sized to
 * the space left between the chrome and the status pill's strip (--pill-h) by
 * these rules, so none of them scrolls by the chrome's height and the pill never
 * covers console content. Partner embeds render no chrome (both variables 0).
 */
const CHROME_CSS = ['.lookahead-main { padding-bottom: var(--pill-h, 0px); }', '.lookahead-main > div.h-screen { height: calc(100dvh - var(--chrome-h, 0px) - var(--pill-h, 0px)); }'].join('\n');

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" data-theme="night" data-density="comfortable" suppressHydrationWarning>
      <head>
        {/* UI pass: theme before first paint (Night default; phones follow prefers-color-scheme; ?theme= for embeds; T remembers a choice). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-bg text-text antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <style dangerouslySetInnerHTML={{ __html: CHROME_CSS }} />
        <TopChrome />
        <div className="lookahead-main" id="main">
          {children}
        </div>
        <SystemStatusPill />
        <ThemeKeys />
        <ShortcutsSheet />
        <CommandPalette />
      </body>
    </html>
  );
}
