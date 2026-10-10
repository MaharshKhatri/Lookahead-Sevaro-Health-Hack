'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CommandResponse, UiRole, ViewDTO } from '@/lib/dto';
import { plainError } from '@/lib/errors';

/**
 * Client-side live state: the latest /api/view, refetched when the SSE
 * stream reports a new version (debounced 200 ms), the demo role, commands
 * and clock controls, and toasts. No engine code runs in the browser.
 */

export type SseStatus = 'connecting' | 'open' | 'reconnecting';

export interface Toast {
  readonly id: number;
  readonly kind: 'ok' | 'error' | 'info';
  readonly text: string;
}

export type CommandInput = { readonly type: string } & Record<string, unknown>;

interface LiveValue {
  readonly view: ViewDTO | null;
  readonly sse: SseStatus;
  readonly role: UiRole;
  readonly setRole: (r: UiRole) => void;
  readonly refetch: () => void;
  readonly send: (command: CommandInput, opts?: { readonly role?: UiRole; readonly actorId?: string; readonly okText?: string; readonly useSeq?: boolean }) => Promise<CommandResponse>;
  readonly clock: (body: Record<string, unknown>) => Promise<void>;
  readonly toasts: readonly Toast[];
  readonly toast: (kind: Toast['kind'], text: string) => void;
  readonly dismiss: (id: number) => void;
}

const LiveContext = createContext<LiveValue | null>(null);

export function useLive(): LiveValue {
  const v = useContext(LiveContext);
  if (v === null) throw new Error('useLive outside LiveProvider');
  return v;
}

const ROLE_KEY = 'lookahead.role';

export function newCommandId(): string {
  // crypto.randomUUID needs a secure context; phones on a LAN address are plain http.
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  return c?.randomUUID?.() ?? `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Subscribes to /api/stream and calls onVersion (debounced) whenever the store version changes. */
export function useStoreVersion(onVersion: () => void, debounceMs = 200): SseStatus {
  const [status, setStatus] = useState<SseStatus>('connecting');
  const cb = useRef(onVersion);
  useEffect(() => {
    cb.current = onVersion;
  });
  useEffect(() => {
    let last: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource('/api/stream');
    es.onopen = () => setStatus('open');
    es.onerror = () => setStatus('reconnecting');
    es.onmessage = (m: MessageEvent<string>) => {
      try {
        const d = JSON.parse(m.data) as { version?: number };
        if (typeof d.version !== 'number' || d.version === last) return;
        const first = last === null;
        last = d.version;
        if (first) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => cb.current(), debounceMs);
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      if (timer !== null) clearTimeout(timer);
      es.close();
    };
  }, [debounceMs]);
  return status;
}

export function LiveProvider({ initial, fixedRole, children }: { readonly initial: ViewDTO | null; readonly fixedRole?: UiRole; readonly children: ReactNode }) {
  const [view, setView] = useState<ViewDTO | null>(initial);
  const [role, setRoleState] = useState<UiRole>(fixedRole ?? 'coordinator');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);
  const inflight = useRef<AbortController | null>(null);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });

  const refetch = useCallback(() => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    fetch('/api/view', { cache: 'no-store', signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`view ${r.status}`);
        setView((await r.json()) as ViewDTO);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      });
  }, []);

  const sse = useStoreVersion(refetch);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (fixedRole !== undefined) return;
    try {
      const saved = window.localStorage.getItem(ROLE_KEY);
      if (saved === 'coordinator') setRoleState(saved);
      // Clinical lead only if this browser still holds the lead PIN cookie (OQ-44).
      if (saved === 'clinical_lead')
        void fetch('/api/auth/lead', { cache: 'no-store' })
          .then((r) => r.json() as Promise<{ lead?: boolean }>)
          .then((b) => {
            if (b.lead === true) setRoleState('clinical_lead');
          });
    } catch {
      // storage unavailable: keep the default role
    }
  }, [fixedRole]);

  const setRole = useCallback((r: UiRole) => {
    setRoleState(r);
    try {
      window.localStorage.setItem(ROLE_KEY, r);
    } catch {
      // ignore
    }
  }, []);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = nextToast.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 5000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const send = useCallback<LiveValue['send']>(
    async (command, opts = {}) => {
      const asRole = opts.role ?? role;
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-lookahead-role': asRole };
      if (opts.actorId !== undefined) headers['x-lookahead-actor-id'] = opts.actorId;
      const seq = opts.useSeq === false ? undefined : viewRef.current?.logSeq;
      let b: CommandResponse;
      try {
        const r = await fetch('/api/commands', { method: 'POST', headers, body: JSON.stringify({ command: { ...command, commandId: newCommandId() }, ...(seq === undefined ? {} : { expectedSeq: seq }) }) });
        b = (await r.json()) as CommandResponse;
      } catch (e) {
        b = { ok: false, code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
      }
      if (b.ok) toast('ok', opts.okText ?? `${command.type}: done`);
      else toast('error', plainError(b.code, b.message));
      refetch();
      return b;
    },
    [role, toast, refetch],
  );

  const clock = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const r = await fetch('/api/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const b = (await r.json()) as { ok: boolean; code?: string; message?: string };
        if (!b.ok) toast('error', plainError(b.code, b.message));
      } catch (e) {
        toast('error', plainError('INTERNAL', e instanceof Error ? e.message : String(e)));
      }
      refetch();
    },
    [toast, refetch],
  );

  const value = useMemo<LiveValue>(() => ({ view, sse, role, setRole, refetch, send, clock, toasts, toast, dismiss }), [view, sse, role, setRole, refetch, send, clock, toasts, toast, dismiss]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
