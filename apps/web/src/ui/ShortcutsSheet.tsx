'use client';

import { useEffect, useState } from 'react';
import { Modal } from './kit';

/** "?" opens the keyboard shortcut sheet (UI pass). Esc closes. */
export const SHORTCUTS: readonly { readonly keys: string; readonly what: string; readonly where: string }[] = [
  { keys: 'J / K', what: 'Move through the next-best-action queue', where: 'Command center' },
  { keys: 'Enter', what: 'Propose the selected action', where: 'Command center (coordinator)' },
  { keys: 'A', what: 'Approve the first pending request', where: 'Lead inbox (clinical lead)' },
  { keys: '⌘K / Ctrl K', what: 'Command palette: jump to a page, hospital, physician or incident; propose an action', where: 'Everywhere' },
  { keys: 'T', what: 'Switch Night / Day theme', where: 'Everywhere' },
  { keys: 'D', what: 'Switch comfortable / compact density', where: 'Everywhere' },
  { keys: '?', what: 'This sheet', where: 'Everywhere' },
  { keys: 'Esc', what: 'Close a panel, sheet or dialog', where: 'Everywhere' },
];

export function ShortcutsSheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      if (e.key === '?') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('lookahead:shortcuts', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('lookahead:shortcuts', onOpen);
    };
  }, []);
  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)} testId="shortcuts-sheet">
      <table className="w-full text-[13px]">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.keys} className="border-b border-border last:border-0">
              <td className="num py-1.5 pr-3 align-top font-semibold whitespace-nowrap text-text">{s.keys}</td>
              <td className="py-1.5 pr-3 text-text">{s.what}</td>
              <td className="py-1.5 text-muted">{s.where}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
