import 'server-only';
import type { Store, StoreEvent } from './store';
import { V1_SCHEMA_VERSION, signBody } from './sign';

/**
 * Outbound webhooks (Phase 8, D-96): every store change (events injected,
 * actions appended, clock moved, reset, dataset swap) is POSTed as a small
 * signed JSON envelope to LOOKAHEAD_WEBHOOK_URL, signed with
 * LOOKAHEAD_WEBHOOK_SECRET (falls back to LOOKAHEAD_INGEST_SECRET) in
 * `x-lookahead-signature: sha256=<hex>`, the same scheme the ingest endpoint
 * verifies. The envelope carries no clinical content: a subscriber refetches
 * /api/v1/* for the state. Deliveries are debounced (WEBHOOK_DEBOUNCE_MS) and
 * fire-and-forget; a failure is logged once per minute, never retried into a
 * storm, and never affects the request that caused it (every AWS/network
 * feature degrades to the local path, CLAUDE.md).
 */

export const WEBHOOK_URL_ENV = 'LOOKAHEAD_WEBHOOK_URL';
export const WEBHOOK_SECRET_ENV = 'LOOKAHEAD_WEBHOOK_SECRET';
export const WEBHOOK_DEBOUNCE_MS = 500;
const LOG_EVERY_MS = 60_000;

export interface WebhookEnvelope {
  readonly schemaVersion: typeof V1_SCHEMA_VERSION;
  readonly event: 'store.changed';
  readonly types: readonly StoreEvent['type'][];
  readonly version: number;
  readonly nowMs: number;
  readonly bootId: string;
  readonly sentAtMs: number;
  readonly links: readonly string[];
}

export type Transport = (url: string, init: { readonly method: 'POST'; readonly headers: Record<string, string>; readonly body: string }) => Promise<{ readonly ok: boolean; readonly status: number }>;

const defaultTransport: Transport = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
  return { ok: r.ok, status: r.status };
};

export interface WebhookConfig {
  readonly url: string | null;
  readonly secret: string | null;
}

export function webhookConfig(env: Readonly<Record<string, string | undefined>> = process.env): WebhookConfig {
  const url = env[WEBHOOK_URL_ENV];
  const secret = env[WEBHOOK_SECRET_ENV] ?? env.LOOKAHEAD_INGEST_SECRET;
  return { url: url === undefined || !/^https?:\/\//.test(url) ? null : url, secret: secret === undefined || secret === '' ? null : secret };
}

export function envelopeFor(events: readonly StoreEvent[], bootId: string, sentAtMs: number): WebhookEnvelope {
  const last = events.at(-1);
  return {
    schemaVersion: V1_SCHEMA_VERSION,
    event: 'store.changed',
    types: [...new Set(events.map((e) => e.type))],
    version: last?.version ?? 0,
    nowMs: last?.nowMs ?? 0,
    bootId,
    sentAtMs,
    links: ['/api/v1/alerts', '/api/v1/incidents', '/api/v1/coverage', '/api/v1/forecast', '/api/v1/standby'],
  };
}

/** One outbound delivery attempt, kept in a ring buffer for the status modal and the simulator (sprint A6/B1). */
export interface WebhookDelivery {
  readonly atMs: number;
  readonly url: string;
  readonly ok: boolean;
  readonly status: number;
  readonly latencyMs: number;
  readonly version: number;
  readonly types: readonly string[];
  readonly error: string | null;
}

export const DELIVERY_LOG_SIZE = 50;
const deliveries: WebhookDelivery[] = [];

/** Newest first, at most DELIVERY_LOG_SIZE. */
export const webhookDeliveries = (): readonly WebhookDelivery[] => deliveries;
export const lastWebhookDelivery = (): WebhookDelivery | null => deliveries[0] ?? null;
/** Tests only. */
export function clearWebhookDeliveries(): void {
  deliveries.length = 0;
}

function record(d: WebhookDelivery): void {
  deliveries.unshift(d);
  deliveries.length = Math.min(deliveries.length, DELIVERY_LOG_SIZE);
}

/** Signs and posts one envelope, recording the attempt. Exposed for tests; the dispatcher below calls it. */
export async function deliver(envelope: WebhookEnvelope, cfg: WebhookConfig, transport: Transport = defaultTransport): Promise<{ readonly ok: boolean; readonly status: number }> {
  if (cfg.url === null) return { ok: false, status: 0 };
  const body = JSON.stringify(envelope);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'lookahead-webhook/1.0' };
  if (cfg.secret !== null) headers['x-lookahead-signature'] = signBody(cfg.secret, body);
  const started = Date.now();
  try {
    const r = await transport(cfg.url, { method: 'POST', headers, body });
    record({ atMs: Date.now(), url: cfg.url, ok: r.ok, status: r.status, latencyMs: Date.now() - started, version: envelope.version, types: envelope.types, error: null });
    return r;
  } catch (e) {
    record({ atMs: Date.now(), url: cfg.url, ok: false, status: 0, latencyMs: Date.now() - started, version: envelope.version, types: envelope.types, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export interface Dispatcher {
  readonly stop: () => void;
  /** Tests: deliveries attempted so far. */
  readonly sent: () => number;
}

/**
 * Subscribes to the store and batches its events. Returns null when no URL is
 * configured (the common case: nothing is subscribed, nothing runs).
 */
export function startWebhooks(store: Store, cfg: WebhookConfig = webhookConfig(), transport: Transport = defaultTransport, debounceMs = WEBHOOK_DEBOUNCE_MS): Dispatcher | null {
  if (cfg.url === null) return null;
  let pending: StoreEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let count = 0;
  let lastLogMs = 0;
  const flush = () => {
    timer = null;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    count++;
    void deliver(envelopeFor(batch, store.snapshot().bootId, Date.now()), cfg, transport)
      .then((r) => {
        if (!r.ok && Date.now() - lastLogMs > LOG_EVERY_MS) {
          lastLogMs = Date.now();
          console.warn(`[lookahead] webhook ${cfg.url} answered ${r.status}`);
        }
      })
      .catch((e: unknown) => {
        if (Date.now() - lastLogMs > LOG_EVERY_MS) {
          lastLogMs = Date.now();
          console.warn(`[lookahead] webhook ${cfg.url} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
  };
  const unsubscribe = store.subscribe((e) => {
    pending.push(e);
    if (timer === null) timer = setTimeout(flush, debounceMs);
  });
  return {
    stop: () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = [];
    },
    sent: () => count,
  };
}
