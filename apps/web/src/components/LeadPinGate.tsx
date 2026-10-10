'use client';

import { useState } from 'react';
import { Button } from './ui';

/** PIN entry for the clinical lead's phone (OQ-44). The PIN is checked server-side; the cookie holds a MAC, not the PIN. */
export function LeadPinGate({ onDone }: { readonly onDone?: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
      if (!r.ok) {
        setError('Wrong PIN.');
        return;
      }
      if (onDone !== undefined) onDone();
      else window.location.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center px-6">
      <div className="text-[13px] font-semibold uppercase tracking-wider text-accent">Clinical lead on duty</div>
      <h1 className="mt-1 text-[26px] font-bold">Enter the lead PIN</h1>
      <form
        className="mt-6 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          data-testid="lead-pin"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          className="num w-full rounded-xl border border-border bg-bg p-4 text-center text-[28px] tracking-[0.3em]"
          aria-label="Lead PIN"
        />
        {error !== null && <p className="text-critical">{error}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={busy || pin.trim() === ''} testId="lead-pin-submit">
          Unlock
        </Button>
      </form>
    </main>
  );
}
