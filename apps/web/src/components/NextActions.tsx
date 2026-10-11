'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NextBestAction } from '@lookahead/engine';
import type { ViewDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import { useLive } from './live';
import { Button, Chip, cx } from './ui';

/**
 * NEXT BEST ACTION queue (Phase 6, D-95): engine-ranked one-click proposals,
 * each pre-filled with the exact command and the approver from DECISION_RIGHTS.
 * Keyboard: J/K move, Enter proposes the selected card (coordinator only).
 * Target: alert -> proposal in <= 3 clicks (one click here).
 */

const KIND_WORD: Readonly<Record<string, string>> = {
  REASSIGN_CONSULT: 'REASSIGN',
  ESCALATE_TO_CLINICAL_LEAD: 'ESCALATE',
  SPLIT_SHIFT_OFFER: 'SPLIT SHIFT',
  STANDBY_PREALERT: 'STANDBY',
  NOTE_HANDOFF_PLAN: 'NOTE HANDOFF',
  VERIFY_PRESENCE: 'VERIFY',
};

const ROLE_WORD: Readonly<Record<string, string>> = { coordinator: 'coordinator', clinical_lead: 'clinical lead', off_shift_physician: 'physician', system: 'system' };

function isTyping(): boolean {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);
}

export function NextActions({ view, limit = 6 }: { readonly view: ViewDTO; readonly limit?: number }) {
  const { role, send } = useLive();
  const actions = useMemo(() => view.intel?.nextBestActions.slice(0, limit) ?? [], [view.intel, limit]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (selected >= actions.length) setSelected(0);
  }, [actions.length, selected]);

  const propose = useCallback(
    async (a: NextBestAction) => {
      if (role !== 'coordinator' || busy !== null) return;
      setBusy(a.id);
      try {
        await send(a.command as { type: string } & Record<string, unknown>, { okText: `${a.title}: proposed` });
      } finally {
        setBusy(null);
      }
    },
    [role, busy, send],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        setSelected((s) => Math.min(actions.length - 1, s + 1));
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
      } else if (e.key === 'Enter') {
        const a = actions[selected];
        if (a !== undefined) {
          e.preventDefault();
          void propose(a);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, selected, propose]);

  if (actions.length === 0) return <p className="px-4 py-3 text-[13px] text-muted">No action to propose at this instant.</p>;
  return (
    <div data-testid="next-actions" className="border-b border-border">
      <div className="flex items-center gap-2 px-4 pt-3">
        <Chip tone="accent">NEXT BEST ACTION</Chip>
        <span className="text-[12px] text-muted">ranked by stroke-minutes averted per coordinator minute · J/K move · Enter proposes</span>
      </div>
      <ol className="space-y-1.5 p-3">
        {actions.map((a, i) => {
          const sel = i === selected;
          const overdue = a.proposeByMs !== null && a.proposeByMs <= view.clock.nowMs;
          return (
            <li
              key={a.id}
              data-testid="nba-card"
              data-nba-kind={a.kind}
              data-selected={sel}
              onClick={() => setSelected(i)}
              className={cx('flex items-start gap-3 rounded-lg border bg-raised/60 px-3 py-2', sel ? 'border-accent' : 'border-border')}
            >
              <span className="num mt-0.5 w-5 shrink-0 text-[14px] font-semibold text-muted">{a.rank}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={a.kind === 'REASSIGN_CONSULT' || a.kind === 'ESCALATE_TO_CLINICAL_LEAD' ? 'critical' : a.kind === 'VERIFY_PRESENCE' ? 'muted' : 'accent'}>{KIND_WORD[a.kind] ?? a.kind}</Chip>
                  <span className="text-[14px] font-semibold leading-tight text-text" data-testid="nba-title">
                    {a.title}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  <span className="num text-text" data-testid="nba-averted">
                    {a.expectedStrokeMinutesAverted}
                  </span>{' '}
                  stroke-min averted · <span className="num">{a.coordinatorMinutes}</span> min of your time · score <span className="num text-text">{a.score}</span>
                  {a.approver !== null && <> · approver: {ROLE_WORD[a.approver] ?? a.approver}</>}
                  {a.proposeByMs !== null && (
                    <>
                      {' '}
                      ·{' '}
                      <span className={overdue ? 'text-critical' : 'text-warning'}>{overdue ? 'propose now' : `propose by ${etHm(a.proposeByMs)}`}</span>
                    </>
                  )}
                </div>
                {sel && (
                  <ul className="mt-1 space-y-0.5 text-[12px] text-muted">
                    {a.why.map((w) => (
                      <li key={w}>· {w}</li>
                    ))}
                  </ul>
                )}
              </div>
              <Button size="sm" testId="nba-propose" disabled={role !== 'coordinator' || busy !== null} title={role === 'coordinator' ? `Send ${a.command.type as string} (one click)` : 'Only the operations coordinator proposes'} onClick={() => void propose(a)}>
                Propose
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
