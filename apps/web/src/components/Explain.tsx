'use client';

import { useCallback, useEffect, useState } from 'react';
import { Chip, cx } from './ui';

/**
 * "Explain": a plain-English briefing of engine facts (POST /api/narrate).
 * Badge "AI-WRITTEN · VERIFIED" when Bedrock's text passed the fidelity guard,
 * "TEMPLATE" otherwise (no AWS, timeout, or a check failed). Never a decision.
 */

interface NarrationResponse {
  readonly text: string;
  readonly source: 'bedrock' | 'template';
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
  readonly modelId: string | null;
  readonly fallbackReason: string | null;
}

export function Explain({ kind, id, auto = false, className }: { readonly kind: 'attention' | 'recommendation' | 'lead_briefing'; readonly id: string; readonly auto?: boolean; readonly className?: string }) {
  const [n, setN] = useState<NarrationResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/narrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, id }) });
      if (r.ok) setN((await r.json()) as NarrationResponse);
    } finally {
      setBusy(false);
    }
  }, [kind, id]);
  useEffect(() => {
    if (auto) void load();
  }, [auto, load]);

  if (n === null)
    return (
      <button type="button" data-testid={`explain-${kind}`} onClick={() => void load()} disabled={busy} className={cx('rounded border border-border px-2 py-0.5 text-[12px] font-semibold text-muted hover:border-accent hover:text-text', className)}>
        {busy ? 'Explaining…' : 'Explain'}
      </button>
    );
  const checks = n.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n');
  return (
    <div data-testid={`narration-${kind}`} data-source={n.source} className={cx('rounded-md border border-border bg-bg/60 p-2.5', className)}>
      <div className="mb-1 flex items-center gap-2">
        {n.source === 'bedrock' ? (
          <Chip tone="accent" title={`${n.modelId ?? ''}\n${checks}`}>
            AI-WRITTEN · VERIFIED
          </Chip>
        ) : (
          <Chip tone="muted" title={`${n.fallbackReason ?? ''}\n${checks}`}>
            TEMPLATE
          </Chip>
        )}
        <span className="text-[11px] text-muted">{n.source === 'bedrock' ? 'every number and name checked against the engine facts' : 'deterministic text from the engine facts'}</span>
      </div>
      <p className="text-[14px] leading-snug text-text/90">{n.text}</p>
    </div>
  );
}
