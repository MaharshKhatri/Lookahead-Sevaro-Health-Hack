import { req } from './helpers';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as narrateRoute from '@/app/api/narrate/route';
import * as viewRoute from '@/app/api/view/route';
import type { ViewDTO } from '@/lib/dto';
import { clearNarrationCache } from '@/server/narrate';
import { BedrockNarrator, pickProfile, setNarrator } from '@/server/narrate/bedrock';
import { factsFor } from '@/server/narrate/facts';
import { checkNarration, numericTokens, templateNarration } from '@/server/narrate/guard';
import { disposeStore } from '@/server/store';

/**
 * Narration (Session 7): LLMs only narrate engine facts. Bedrock is mocked;
 * the fidelity guard is deterministic and decides what is served.
 */

const runtime = mockClient(BedrockRuntimeClient);
const control = mockClient(BedrockClient);
const PROFILES = [
  { inferenceProfileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', status: 'ACTIVE' },
  { inferenceProfileId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', status: 'ACTIVE' },
  { inferenceProfileId: 'us.meta.llama3-1-8b-instruct-v1:0', status: 'ACTIVE' },
] as const;

let view: ViewDTO;
const topId = () => view.attention[0]?.id ?? '';
const reply = (text: string) => runtime.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ text }] } }, stopReason: 'end_turn' } as never);
const narrateTop = async () =>
  (await (await narrateRoute.POST(req('/api/narrate', { method: 'POST', body: JSON.stringify({ kind: 'attention', id: topId() }) }))).json()) as { text: string; source: string; checks: { name: string; ok: boolean; detail: string }[]; fallbackReason: string | null };

beforeAll(async () => {
  disposeStore();
  await resetRoute.POST();
  view = (await (await viewRoute.GET(req('/api/view'))).json()) as ViewDTO;
});
afterAll(() => {
  setNarrator(undefined);
  disposeStore();
});
beforeEach(() => {
  clearNarrationCache();
  runtime.reset();
  control.reset();
  control.on(ListInferenceProfilesCommand).resolves({ inferenceProfileSummaries: [...PROFILES] } as never);
  setNarrator(new BedrockNarrator(new BedrockRuntimeClient({ region: 'us-east-1' }), new BedrockClient({ region: 'us-east-1' }), { AWS_REGION: 'us-east-1' }));
});

describe('templates (the fallback) always pass their own guard', () => {
  it('every attention item at 18:20, the recommendation: no PHI, no foreign numbers or names, <= 60 words', () => {
    const all = [...view.attention.map((a) => factsFor(view, 'attention', a.id)), factsFor(view, 'recommendation', 'top')];
    for (const f of all) {
      expect(f).not.toBeNull();
      const t = templateNarration(f!);
      expect(checkNarration(t, f!).filter((c) => !c.ok), t).toEqual([]);
      expect(t).not.toMatch(/\bCON-\d+|\bstroke\b|\bimaging\b/i);
    }
  });
});

describe('fidelity guard', () => {
  const facts = () => factsFor(view, 'attention', topId())!;
  it('time and number normalization: "6:09 PM" equals 18:09; spelled numbers count', () => {
    expect([...numericTokens('first at 6:09 PM, three attempts').times]).toEqual(['18:09']);
    expect([...numericTokens('three attempts').numbers]).toEqual(['3']);
  });
  it('rejects a hallucinated number', () => {
    const c = checkNarration('Oak Valley Medical has had 17 failed routing attempts since 18:09.', facts());
    expect(c.find((x) => x.name === 'numbers')).toMatchObject({ ok: false, detail: expect.stringContaining('17') });
  });
  it('rejects a consult id (PHI denylist and names)', () => {
    const c = checkNarration('CON-2105 at Oak Valley Medical has no routable physician.', facts());
    expect(c.find((x) => x.name === 'phi')?.ok).toBe(false);
    expect(c.find((x) => x.name === 'names')?.ok).toBe(false);
  });
  it('rejects the word "stroke" (clinical term)', () => {
    expect(checkNarration('A stroke consult at Oak Valley Medical has no routable physician.', facts()).find((x) => x.name === 'phi')).toMatchObject({ ok: false, detail: expect.stringContaining('stroke') });
  });
  it('rejects a name that is not in the facts', () => {
    expect(checkNarration('Dr. Smith at Oak Valley Medical is busy.', facts()).find((x) => x.name === 'names')).toMatchObject({ ok: false, detail: expect.stringContaining('Smith') });
  });
});

describe('POST /api/narrate with Bedrock mocked', () => {
  it('a faithful model text is served as "bedrock" with all checks passing; the model is the Haiku profile', async () => {
    reply('A time-critical consult at Oak Valley Medical has no routable physician: routing has failed 3 times since 18:09:10 ET. Dr. Daniel Kim is on Synapse video and Dr. Noah Williams is Temporarily Unavailable.');
    const r = await narrateTop();
    expect(r.source).toBe('bedrock');
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(runtime.commandCalls(ConverseCommand)[0]?.args[0].input.modelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    const input = runtime.commandCalls(ConverseCommand)[0]?.args[0].input;
    const user = input?.messages?.[0]?.content?.[0];
    expect(user !== undefined && 'text' in user ? user.text : '').not.toMatch(/CON-\d+|EVT-\d+|stroke/i);
  });

  it('an injected hallucinated number falls back to the template, with the failed check listed', async () => {
    reply('Oak Valley Medical has had 17 failed routing attempts in the last hour.');
    const r = await narrateTop();
    expect(r.source).toBe('template');
    expect(r.fallbackReason).toContain('numbers');
    expect(r.checks.find((c) => c.name === 'numbers')?.ok).toBe(false);
    expect(r.text).toBe(templateNarration(factsFor(view, 'attention', topId())!));
  });

  it('a consult id or "stroke" in the output falls back to the template', async () => {
    reply('Stroke consult CON-2105 at Oak Valley Medical has no routable physician.');
    const r = await narrateTop();
    expect(r.source).toBe('template');
    expect(r.checks.find((c) => c.name === 'phi')?.ok).toBe(false);
  });

  it('timeout falls back to the template', async () => {
    runtime.on(ConverseCommand).callsFake(() => new Promise((_res, rej) => setTimeout(() => rej(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), 20)));
    const r = await narrateTop();
    expect(r).toMatchObject({ source: 'template', fallbackReason: 'timeout' });
  });

  it('credential errors (no AWS) fall back to the template', async () => {
    control.reset();
    control.on(ListInferenceProfilesCommand).rejects(Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' }));
    const r = await narrateTop();
    expect(r.source).toBe('template');
    expect(r.fallbackReason).toContain('CredentialsProviderError');
  });

  it('unknown items are 404 and bad kinds 400', async () => {
    expect((await narrateRoute.POST(req('/api/narrate', { method: 'POST', body: JSON.stringify({ kind: 'attention', id: 'att-nope' }) }))).status).toBe(404);
    expect((await narrateRoute.POST(req('/api/narrate', { method: 'POST', body: JSON.stringify({ kind: 'diagnosis', id: 'x' }) }))).status).toBe(400);
  });
});

describe('model discovery', () => {
  it('prefers Claude Haiku over Sonnet, ignores non-Claude, prefers the region\'s geo prefix', () => {
    expect(pickProfile([...PROFILES], 'us-east-1')).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(pickProfile([{ inferenceProfileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }], 'us-east-1')).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(pickProfile([{ inferenceProfileId: 'us.meta.llama3-1-8b-instruct-v1:0' }], 'us-east-1')).toBeNull();
  });
  it('BEDROCK_MODEL_ID overrides discovery', async () => {
    const n = new BedrockNarrator(new BedrockRuntimeClient({ region: 'us-east-1' }), new BedrockClient({ region: 'us-east-1' }), { BEDROCK_MODEL_ID: 'my-profile' });
    expect(await n.status()).toEqual({ available: true, modelId: 'my-profile', reason: null });
    expect(control.commandCalls(ListInferenceProfilesCommand)).toHaveLength(0);
  });
});
