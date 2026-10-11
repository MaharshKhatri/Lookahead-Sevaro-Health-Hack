'use client';

import { useEffect } from 'react';

/**
 * Theme and density (UI pass). Night is the console default; phone pages
 * (/offer, /standby, /lead) follow prefers-color-scheme; /embed/* takes
 * ?theme=day|night; a choice made with the T key is remembered per browser
 * (localStorage, wrapped in try/catch). D toggles compact density.
 * THEME_SCRIPT runs before paint (no flash); ThemeKeys binds the keys.
 */

import { DENSITY_KEY, THEME_KEY } from './themeScript';

function typing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);
}

export function toggleTheme(): 'day' | 'night' {
  const d = document.documentElement;
  const next = d.getAttribute('data-theme') === 'day' ? 'night' : 'day';
  d.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // private window: the choice lasts for this page only
  }
  return next;
}

export function toggleDensity(): 'compact' | 'comfortable' {
  const d = document.documentElement;
  const next = d.getAttribute('data-density') === 'compact' ? 'comfortable' : 'compact';
  d.setAttribute('data-density', next);
  try {
    localStorage.setItem(DENSITY_KEY, next);
  } catch {
    // ignore
  }
  return next;
}

export function ThemeKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing()) return;
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        toggleTheme();
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        toggleDensity();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
