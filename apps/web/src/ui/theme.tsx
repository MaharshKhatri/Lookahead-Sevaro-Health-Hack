'use client';

import { useEffect } from 'react';

/**
 * Theme and density (UI pass). Night is the console default; phone pages
 * (/offer, /standby, /lead) follow prefers-color-scheme; /embed/* takes
 * ?theme=day|night; a choice made with the T key is remembered per browser
 * (localStorage, wrapped in try/catch). D toggles compact density.
 * THEME_SCRIPT runs before paint (no flash); ThemeKeys binds the keys.
 */

export const THEME_KEY = 'lh-theme';
export const DENSITY_KEY = 'lh-density';

export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,p=location.pathname,q=new URLSearchParams(location.search).get('theme'),s=null;try{s=localStorage.getItem('${THEME_KEY}')}catch(e){}var t=(q==='day'||q==='night')?q:(s==='day'||s==='night')?s:(/^\\/(offer|standby|lead)/.test(p)&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'day':'night';d.setAttribute('data-theme',t);var n=null;try{n=localStorage.getItem('${DENSITY_KEY}')}catch(e){}d.setAttribute('data-density',n==='compact'?'compact':'comfortable')}catch(e){}})();`;

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
