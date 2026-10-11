'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewDTO } from '@/lib/dto';
import { cx } from './kit';

/**
 * ⌘K / Ctrl K command palette (UI pass): jump to any page, hospital,
 * physician or incident, or propose one of the engine's next best actions.
 * Fully keyboard-usable (type to filter, arrows, Enter, Esc). Entries come
 * from /api/view at open time. Proposing dispatches `lookahead:propose`
 * ({actionId}) to the command center's queue, which sends the engine's
 * pre-filled command as the coordinator; elsewhere it opens the command
 * center first. Focus jumps dispatch `lookahead:focus` ({kind, id}).
 */

export interface PaletteEntry {
  readonly key: string;
  readonly group: 'Page' | 'Hospital' | 'Physician' | 'Incident' | 'Propose';
  readonly label: string;
  readonly hint: string;
  readonly run: () => void;
}

const PAGES: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/', label: 'Command center' },
  { href: '/opener', label: 'Opener: what Lookahead would have done today' },
  { href: '/rewind', label: 'Rewind: actual vs reactive vs anticipatory' },
  { href: '/quality', label: 'Forecast quality (backtest)' },
  { href: '/architecture', label: 'Architecture: AI narrates, humans decide' },
  { href: '/simulator', label: 'Upstream event simulator' },
  { href: '/lead', label: 'Clinical lead inbox' },
  { href: '/state', label: 'Physician and consult state' },
  { href: '/integrity', label: 'Replay integrity' },
  { href: '/inject', label: 'Inject events' },
  { href: '/clinical-sources', label: 'Clinical sources' },
  { href: '/design', label: 'Design system' },
  { href: '/admin/dataset', label: 'Dataset admin' },
];

const go = (href: string) => {
  window.location.href = href;
};

function onConsole(): boolean {
  return window.location.pathname === '/';
}

export function paletteEntries(view: ViewDTO | null): PaletteEntry[] {
  const out: PaletteEntry[] = PAGES.map((p) => ({ key: `page:${p.href}`, group: 'Page', label: p.label, hint: p.href, run: () => go(p.href) }));
  if (view === null) return out;
  const focus = (kind: string, id: string) => () => {
    if (onConsole()) window.dispatchEvent(new CustomEvent('lookahead:focus', { detail: { kind, id } }));
    else go(`/?focus=${encodeURIComponent(`${kind}:${id}`)}`);
  };
  for (const a of view.intel.nextBestActions) {
    out.push({
      key: `nba:${a.id}`,
      group: 'Propose',
      label: a.title,
      hint: `${a.expectedStrokeMinutesAverted} stroke-min averted`,
      run: () => {
        if (onConsole()) window.dispatchEvent(new CustomEvent('lookahead:propose', { detail: { actionId: a.id } }));
        else go(`/?propose=${encodeURIComponent(a.id)}`);
      },
    });
  }
  for (const r of view.coverage.rows) out.push({ key: `h:${r.hospitalId}`, group: 'Hospital', label: r.hospitalName, hint: `${r.hospitalId} · ${r.worst.replace('_', ' ').toLowerCase()}`, run: focus('hospital', r.hospitalId) });
  for (const p of view.physicians) out.push({ key: `p:${p.physicianId}`, group: 'Physician', label: p.name ?? p.physicianId, hint: p.physicianId, run: focus('physician', p.physicianId) });
  for (const i of view.intel.incidents) out.push({ key: `i:${i.id}`, group: 'Incident', label: i.headline, hint: `${i.memberItemIds.length} item${i.memberItemIds.length === 1 ? '' : 's'}`, run: focus('incident', i.id) });
  return out;
}

export function filterEntries(entries: readonly PaletteEntry[], q: string): PaletteEntry[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries.slice(0, 40);
  return entries.filter((e) => terms.every((t) => `${e.group} ${e.label} ${e.hint}`.toLowerCase().includes(t))).slice(0, 40);
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [view, setView] = useState<ViewDTO | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('lookahead:palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('lookahead:palette', onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    input.current?.focus();
    void fetch('/api/view')
      .then((r) => (r.ok ? (r.json() as Promise<ViewDTO>) : null))
      .then(setView)
      .catch(() => setView(null));
  }, [open]);

  const entries = useMemo(() => filterEntries(paletteEntries(view), q), [view, q]);
  const run = useCallback(
    (e: PaletteEntry | undefined) => {
      if (e === undefined) return;
      setOpen(false);
      e.run();
    },
    [setOpen],
  );

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-bg/70 p-4 pt-[12vh]" onClick={() => setOpen(false)} role="presentation">
      <div role="dialog" aria-modal="true" aria-label="Command palette" data-testid="command-palette" className="w-full max-w-xl rounded-[2px] border border-border bg-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(entries.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(entries[sel]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Jump to a page, hospital, physician or incident; or propose an action"
          aria-label="Search"
          aria-controls="palette-list"
          aria-activedescendant={entries[sel] === undefined ? undefined : `pal-${sel}`}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[15px] text-text outline-none placeholder:text-ink3"
          data-testid="palette-input"
        />
        <ul id="palette-list" role="listbox" className="scroll-thin max-h-[50vh] overflow-y-auto py-1">
          {entries.map((e, i) => (
            <li
              key={e.key}
              id={`pal-${i}`}
              role="option"
              aria-selected={i === sel}
              data-testid="palette-entry"
              onMouseEnter={() => setSel(i)}
              onClick={() => run(e)}
              className={cx('flex cursor-pointer items-baseline gap-3 px-4 py-1.5 text-[13px]', i === sel ? 'bg-raised text-text' : 'text-muted')}
            >
              <span className={cx('w-20 shrink-0 text-[11px] uppercase tracking-wide', e.group === 'Propose' ? 'text-accent' : 'text-ink3')}>{e.group}</span>
              <span className="min-w-0 flex-1 truncate text-text">{e.label}</span>
              <span className="num shrink-0 text-[11px] text-ink3">{e.hint}</span>
            </li>
          ))}
          {entries.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">No match.</li>}
        </ul>
      </div>
    </div>
  );
}
