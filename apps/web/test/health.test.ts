import { body } from './helpers';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as healthRoute from '@/app/api/health/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import { HEALTH_CHECK_TIMEOUT_MS, bedrockCheck, dynamoCheck, runHealthChecks, setHealthChecks, type BedrockCheck, type DynamoCheck, type HealthChecks } from '@/server/health';
import { setNarrator } from '@/server/narrate/bedrock';
import { disposeStore, getReadyStore } from '@/server/store';

/**
 * Sprint A6 /api/health: every original field kept, plus uptime, event count,
 * bounded AWS checks and `live` (true only when BOTH checks are ok). The AWS
 * checks are injected (no network in tests).
 */

const OK_DYNAMO: DynamoCheck = { status: 'ok', latencyMs: 12, table: 'lookahead-log', detail: 'mock' };
const OK_BEDROCK: BedrockCheck = { status: 'ok', latencyMs: 34, modelId: 'mock-model', detail: 'mock' };
const okChecks: HealthChecks = { dynamo: async () => OK_DYNAMO, bedrock: async () => OK_BEDROCK };
const never = <T>() => new Promise<T>(() => {});

beforeEach(async () => {
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
  // The legacy bedrock field calls the narrator; a stub keeps the test offline.
  setNarrator({ status: async () => ({ available: false, modelId: null, reason: 'test' }), generate: async () => ({ text: '', modelId: 'x' }) });
});
afterEach(() => {
  setHealthChecks(undefined);
  setNarrator(undefined);
});
afterAll(() => disposeStore());

const health = async () => body<Record<string, unknown> & { checks: { dynamo: DynamoCheck; bedrock: BedrockCheck }; live: boolean }>(await healthRoute.GET());

describe('GET /api/health', () => {
  it('keeps every original field and adds uptime, events, checks, region, deployedUrl, live, lastWebhook, testReport', async () => {
    setHealthChecks(okChecks);
    const h = await health();
    for (const k of ['ok', 'store', 'bedrock', 'bedrockModel', 'bedrockReason', 'dataset', 'datasetVersion', 'version', 'clock', 'logSeq', 'conflictsResolved', 'bootWarnings', 'publicOrigin']) expect(h, k).toHaveProperty(k);
    for (const k of ['uptimeMs', 'events', 'checks', 'region', 'deployedUrl', 'live', 'lastWebhook', 'testReport']) expect(h, k).toHaveProperty(k);
    const store = (await getReadyStore()).snapshot();
    expect(h.events).toBe(store.dataset.events.length);
    expect(typeof h.uptimeMs).toBe('number');
    expect(h.uptimeMs as number).toBeGreaterThan(0);
  });

  it('ok/ok: live is true and both checks are reported', async () => {
    setHealthChecks(okChecks);
    const h = await health();
    expect(h.live).toBe(true);
    expect(h.checks.dynamo).toEqual(OK_DYNAMO);
    expect(h.checks.bedrock).toEqual(OK_BEDROCK);
  });

  it('one check unavailable or not configured: live is false', async () => {
    setHealthChecks({ dynamo: async () => ({ ...OK_DYNAMO, status: 'not_configured', latencyMs: null }), bedrock: async () => OK_BEDROCK });
    expect((await health()).live).toBe(false);
    setHealthChecks({ dynamo: async () => OK_DYNAMO, bedrock: async () => Promise.reject(new Error('AccessDenied')) });
    const h = await health();
    expect(h.live).toBe(false);
    expect(h.checks.bedrock.status).toBe('unavailable');
    expect(h.checks.bedrock.detail).toContain('AccessDenied');
  });

  it('a hanging check times out as unavailable within the budget, and health still answers', async () => {
    setHealthChecks({ dynamo: () => never<DynamoCheck>(), bedrock: () => never<BedrockCheck>() });
    // The legacy narrator status hangs too: it is bounded by the same budget.
    setNarrator({ status: () => never(), generate: async () => ({ text: '', modelId: 'x' }) });
    const started = Date.now();
    const h = await health();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS + 700);
    expect(h.live).toBe(false);
    expect(h.checks.dynamo.status).toBe('unavailable');
    expect(h.checks.bedrock.status).toBe('unavailable');
    expect(h.checks.dynamo.detail).toContain('timed out');
    expect(h.bedrock).toBe('unavailable');
  });
});

describe('real check functions degrade honestly without AWS configuration', () => {
  it('dynamo: not_configured unless STORE=dynamo with TABLE_NAME', async () => {
    expect((await dynamoCheck({}, () => 'file')(HEALTH_CHECK_TIMEOUT_MS)).status).toBe('not_configured');
    expect((await dynamoCheck({ STORE: 'dynamo' }, () => 'file')(HEALTH_CHECK_TIMEOUT_MS)).status).toBe('not_configured');
  });

  it('bedrock: not_configured with NARRATION=off or no region', async () => {
    expect((await bedrockCheck({ NARRATION: 'off', AWS_REGION: 'us-east-1' })(HEALTH_CHECK_TIMEOUT_MS)).status).toBe('not_configured');
    expect((await bedrockCheck({})(HEALTH_CHECK_TIMEOUT_MS)).status).toBe('not_configured');
  });

  it('runHealthChecks bounds a slow check to the given budget', async () => {
    const started = Date.now();
    const r = await runHealthChecks({ dynamo: () => never<DynamoCheck>(), bedrock: async () => OK_BEDROCK }, 50);
    expect(Date.now() - started).toBeLessThan(400);
    expect(r.dynamo).toMatchObject({ status: 'unavailable', latencyMs: 50 });
    expect(r.bedrock.status).toBe('ok');
  });
});
