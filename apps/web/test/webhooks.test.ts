import { body, req } from './helpers';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as clockRoute from '@/app/api/clock/route';
import { signBody } from '@/server/sign';
import { disposeStore, getReadyStore } from '@/server/store';
import { type Transport, type WebhookEnvelope, deliver, envelopeFor, startWebhooks, webhookConfig } from '@/server/webhooks';

/** Outbound webhooks (D-96): signed envelopes on store changes, debounced, nothing without a URL. */

beforeEach(async () => {
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterAll(() => disposeStore());

const capture = () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  return { calls, transport };
};

describe('webhooks', () => {
  it('no URL configured: nothing starts, deliver is a no-op', async () => {
    expect(webhookConfig({}).url).toBeNull();
    expect(webhookConfig({ LOOKAHEAD_WEBHOOK_URL: 'ftp://x' }).url).toBeNull();
    expect(startWebhooks(await getReadyStore(), { url: null, secret: null })).toBeNull();
    expect(await deliver(envelopeFor([], 'b', 0), { url: null, secret: 's' })).toEqual({ ok: false, status: 0 });
  });

  it('a clock move produces one signed envelope (debounced) whose signature verifies with the secret', async () => {
    const store = await getReadyStore();
    const { calls, transport } = capture();
    const d = startWebhooks(store, { url: 'https://example.invalid/hook', secret: 'hook-secret' }, transport, 10);
    expect(d).not.toBeNull();
    const clock = (b: Record<string, unknown>) => clockRoute.POST(req('/api/clock', { method: 'POST', body: JSON.stringify(b) }));
    expect((await clock({ action: 'advance', minutes: 1 })).status).toBe(200);
    expect((await clock({ action: 'advance', minutes: 1 })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.length).toBe(1);
    const env = JSON.parse(calls[0]?.body ?? '{}') as WebhookEnvelope;
    expect(env.schemaVersion).toBe('1.0');
    expect(env.event).toBe('store.changed');
    expect(env.types).toContain('clock');
    expect(env.version).toBe(store.snapshot().version);
    expect(env.links).toContain('/api/v1/alerts');
    expect(calls[0]?.headers['x-lookahead-signature']).toBe(signBody('hook-secret', calls[0]?.body ?? ''));
    expect(JSON.stringify(env)).not.toMatch(/CON-\d+|PHY-\d+/);
    d?.stop();
    expect((await clock({ action: 'advance', minutes: 1 })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBe(1);
    expect(d?.sent()).toBe(1);
    void body;
  });
});
