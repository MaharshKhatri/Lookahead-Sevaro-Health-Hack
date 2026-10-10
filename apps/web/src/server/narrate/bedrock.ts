import 'server-only';
import { BedrockClient, ListInferenceProfilesCommand, type InferenceProfileSummary } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

/**
 * Claude on Amazon Bedrock through the Converse API (Session 7). Narration
 * only, never decisions. The model is discovered at startup with
 * ListInferenceProfiles (a Claude Haiku profile for speed, else Sonnet);
 * BEDROCK_MODEL_ID overrides. Every call has a hard timeout; any failure
 * (no credentials, no model access, throttling, timeout) is reported to the
 * caller, which serves the template narration instead.
 */

export const NARRATION_TIMEOUT_MS = 4_000;
const STATUS_TTL_MS = 60_000;

export interface NarratorStatus {
  readonly available: boolean;
  readonly modelId: string | null;
  readonly reason: string | null;
}

export interface Narrator {
  status(): Promise<NarratorStatus>;
  /** Plain text from the model, or throws. */
  generate(system: string, user: string, timeoutMs?: number): Promise<{ text: string; modelId: string }>;
}

type Env = Readonly<Record<string, string | undefined>>;

const region = (env: Env) => env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1';

/** Prefers Claude Haiku, then Sonnet, then any Claude; newest id first (ids embed release dates/versions). */
export function pickProfile(profiles: readonly Partial<Pick<InferenceProfileSummary, 'inferenceProfileId' | 'status'>>[], awsRegion: string): string | null {
  const claude = profiles.filter((p) => /anthropic\.claude/i.test(p.inferenceProfileId ?? '') && (p.status === undefined || p.status === 'ACTIVE'));
  const tier = (id: string) => (/haiku/i.test(id) ? 2 : /sonnet/i.test(id) ? 1 : 0);
  const geo = (id: string) => (id.startsWith(`${awsRegion.split('-')[0]}.`) ? 1 : id.startsWith('global.') ? 0.5 : 0);
  const ranked = claude
    .map((p) => p.inferenceProfileId ?? '')
    .sort((a, b) => tier(b) - tier(a) || geo(b) - geo(a) || (a < b ? 1 : a > b ? -1 : 0));
  return ranked[0] ?? null;
}

export class BedrockNarrator implements Narrator {
  private model: Promise<NarratorStatus> | null = null;
  private checkedAt = 0;
  private noEffort = new Set<string>();

  constructor(
    private readonly runtime: BedrockRuntimeClient,
    private readonly control: BedrockClient,
    private readonly env: Env = process.env,
  ) {}

  status(): Promise<NarratorStatus> {
    if (this.model === null || Date.now() - this.checkedAt > STATUS_TTL_MS) {
      this.checkedAt = Date.now();
      this.model = this.discover();
    }
    return this.model;
  }

  private async discover(): Promise<NarratorStatus> {
    if (this.env.NARRATION === 'off') return { available: false, modelId: null, reason: 'NARRATION=off' };
    const override = this.env.BEDROCK_MODEL_ID;
    if (override !== undefined && override !== '') return { available: true, modelId: override, reason: null };
    try {
      const profiles: InferenceProfileSummary[] = [];
      let next: string | undefined;
      do {
        const r = await this.control.send(new ListInferenceProfilesCommand({ maxResults: 100, ...(next === undefined ? {} : { nextToken: next }) }), { abortSignal: AbortSignal.timeout(NARRATION_TIMEOUT_MS) });
        profiles.push(...(r.inferenceProfileSummaries ?? []));
        next = r.nextToken;
      } while (next !== undefined);
      const modelId = pickProfile(profiles, region(this.env));
      return modelId === null ? { available: false, modelId: null, reason: 'no Claude inference profile in this account/region' } : { available: true, modelId, reason: null };
    } catch (e) {
      return { available: false, modelId: null, reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
  }

  async generate(system: string, user: string, timeoutMs = NARRATION_TIMEOUT_MS): Promise<{ text: string; modelId: string }> {
    const st = await this.status();
    if (!st.available || st.modelId === null) throw new Error(`Bedrock unavailable: ${st.reason ?? 'unknown'}`);
    const modelId = st.modelId;
    // Low effort keeps Claude 5.x narration fast; models that reject the field are remembered and called without it.
    const effort = /claude-(haiku|sonnet|opus)-5/i.test(modelId) && !this.noEffort.has(modelId);
    const send = (withEffort: boolean) =>
      this.runtime.send(
        new ConverseCommand({
          modelId,
          system: [{ text: system }],
          messages: [{ role: 'user', content: [{ text: user }] }],
          inferenceConfig: { maxTokens: 1024 },
          ...(withEffort ? { additionalModelRequestFields: { output_config: { effort: 'low' } } } : {}),
        }),
        { abortSignal: AbortSignal.timeout(timeoutMs) },
      );
    let r;
    try {
      r = await send(effort);
    } catch (e) {
      if (!effort || (e as { name?: string }).name !== 'ValidationException') throw e;
      this.noEffort.add(modelId);
      r = await send(false);
    }
    const text = (r.output?.message?.content ?? [])
      .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
      .join('')
      .trim();
    if (text === '') throw new Error(`empty response (stopReason ${r.stopReason ?? '?'})`);
    return { text, modelId };
  }
}

const holder = globalThis as unknown as { __lookaheadNarrator?: Narrator };

export function getNarrator(): Narrator {
  holder.__lookaheadNarrator ??= new BedrockNarrator(new BedrockRuntimeClient({ region: region(process.env), maxAttempts: 1 }), new BedrockClient({ region: region(process.env), maxAttempts: 1 }));
  return holder.__lookaheadNarrator;
}

/** Tests: inject a narrator (or reset to the default with undefined). */
export function setNarrator(n: Narrator | undefined): void {
  if (n === undefined) delete holder.__lookaheadNarrator;
  else holder.__lookaheadNarrator = n;
}

/** Called once at server start (instrumentation.ts) so the first Explain click is fast. */
export async function warmNarrator(): Promise<void> {
  const st = await getNarrator().status();
  console.log(`[lookahead] narration: ${st.available ? `Bedrock ${st.modelId}` : `template only (${st.reason})`}`);
}
