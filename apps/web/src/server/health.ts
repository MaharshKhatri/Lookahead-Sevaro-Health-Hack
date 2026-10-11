import 'server-only';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { getNarrator } from './narrate/bedrock';

/**
 * Deploy health (sprint A6, LOOKAHEAD-DEFINED). Two live AWS checks, each with
 * a hard HEALTH_CHECK_TIMEOUT_MS budget (Promise.race), so /api/health never
 * hangs and the status pill never claims "live" without a real round trip:
 *  - dynamo: one Query (Limit 1) against TABLE_NAME (the IAM policy grants
 *    dynamodb:Query; DescribeTable is not granted), and the store's own
 *    backend must not have degraded to the file fallback;
 *  - bedrock: one ListInferenceProfiles (maxResults 1) round trip (granted to
 *    the narrator for discovery) plus the narrator's model status.
 * Both degrade honestly: 'not_configured' when the environment never asked
 * for AWS, 'unavailable' on any error or timeout. Check functions are
 * injectable for tests (setHealthChecks).
 */

export type CheckStatus = 'ok' | 'unavailable' | 'not_configured';

export interface DynamoCheck {
  readonly status: CheckStatus;
  readonly latencyMs: number | null;
  readonly table: string | null;
  readonly detail: string;
}

export interface BedrockCheck {
  readonly status: CheckStatus;
  readonly latencyMs: number | null;
  readonly modelId: string | null;
  readonly detail: string;
}

export interface HealthCheckResults {
  readonly dynamo: DynamoCheck;
  readonly bedrock: BedrockCheck;
}

export interface HealthChecks {
  readonly dynamo: (timeoutMs: number) => Promise<DynamoCheck>;
  readonly bedrock: (timeoutMs: number) => Promise<BedrockCheck>;
}

/** LOOKAHEAD-DEFINED: hard per-check budget; health answers within this plus overhead. */
export const HEALTH_CHECK_TIMEOUT_MS = 800;
/** LOOKAHEAD-DEFINED: default (real AWS) results are reused this long, so many open pages do not each probe AWS. */
export const HEALTH_CACHE_MS = 15_000;

type Env = Readonly<Record<string, string | undefined>>;

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const regionOf = (env: Env): string | null => env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? null;

/** Promise.race against a timer; the timer is always cleared. */
export async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Runs both checks in parallel; each is bounded by timeoutMs and any throw reads as 'unavailable'. */
export async function runHealthChecks(checks: HealthChecks, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<HealthCheckResults> {
  const timedOut = `timed out after ${timeoutMs} ms`;
  const dynamo = withTimeout(
    checks.dynamo(timeoutMs).catch((e: unknown): DynamoCheck => ({ status: 'unavailable', latencyMs: null, table: null, detail: errText(e) })),
    timeoutMs,
    (): DynamoCheck => ({ status: 'unavailable', latencyMs: timeoutMs, table: null, detail: timedOut }),
  );
  const bedrock = withTimeout(
    checks.bedrock(timeoutMs).catch((e: unknown): BedrockCheck => ({ status: 'unavailable', latencyMs: null, modelId: null, detail: errText(e) })),
    timeoutMs,
    (): BedrockCheck => ({ status: 'unavailable', latencyMs: timeoutMs, modelId: null, detail: timedOut }),
  );
  const [d, b] = await Promise.all([dynamo, bedrock]);
  return { dynamo: d, bedrock: b };
}

/** live only when BOTH AWS checks are ok (never inferred from configuration alone). */
export const isLive = (r: HealthCheckResults): boolean => r.dynamo.status === 'ok' && r.bedrock.status === 'ok';

// ------------------------------------------------------------ real checks

interface ClientHolder {
  __lookaheadHealthDynamo?: { region: string; client: DynamoDBClient };
  __lookaheadHealthBedrock?: { region: string; client: BedrockClient };
}
const holder = globalThis as unknown as ClientHolder;

function dynamoClient(region: string): DynamoDBClient {
  if (holder.__lookaheadHealthDynamo?.region !== region) holder.__lookaheadHealthDynamo = { region, client: new DynamoDBClient({ region, maxAttempts: 1 }) };
  return holder.__lookaheadHealthDynamo.client;
}

function bedrockClient(region: string): BedrockClient {
  if (holder.__lookaheadHealthBedrock?.region !== region) holder.__lookaheadHealthBedrock = { region, client: new BedrockClient({ region, maxAttempts: 1 }) };
  return holder.__lookaheadHealthBedrock.client;
}

/** DynamoDB: STORE=dynamo with TABLE_NAME, one Query round trip, and the store backend not degraded (storeKind from the store snapshot). */
export function dynamoCheck(env: Env, storeKind: () => string): (timeoutMs: number) => Promise<DynamoCheck> {
  return async (timeoutMs) => {
    const table = env.TABLE_NAME ?? '';
    if ((env.STORE ?? 'file') !== 'dynamo') return { status: 'not_configured', latencyMs: null, table: table === '' ? null : table, detail: 'STORE is not dynamo: action log on local files' };
    if (table === '') return { status: 'not_configured', latencyMs: null, table: null, detail: 'STORE=dynamo but TABLE_NAME is not set' };
    const started = Date.now();
    try {
      await dynamoClient(regionOf(env) ?? 'us-east-1').send(
        new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: 'health#probe' } }, Limit: 1 }),
        { abortSignal: AbortSignal.timeout(timeoutMs) },
      );
    } catch (e) {
      return { status: 'unavailable', latencyMs: Date.now() - started, table, detail: errText(e) };
    }
    const latencyMs = Date.now() - started;
    const kind = storeKind();
    if (kind.startsWith('file')) return { status: 'unavailable', latencyMs, table, detail: `table reachable but the store runs on ${kind}` };
    return { status: 'ok', latencyMs, table, detail: `Query round trip on ${table}; store backend ${kind}` };
  };
}

/** Bedrock: NARRATION not off and a region configured; one ListInferenceProfiles round trip and an available narrator model. */
export function bedrockCheck(env: Env): (timeoutMs: number) => Promise<BedrockCheck> {
  return async (timeoutMs) => {
    if (env.NARRATION === 'off') return { status: 'not_configured', latencyMs: null, modelId: null, detail: 'NARRATION=off: template narration only' };
    const region = regionOf(env);
    if (region === null) return { status: 'not_configured', latencyMs: null, modelId: null, detail: 'AWS_REGION is not set: template narration only' };
    const started = Date.now();
    const narrator = getNarrator().status();
    try {
      await bedrockClient(region).send(new ListInferenceProfilesCommand({ maxResults: 1 }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { status: 'unavailable', latencyMs: Date.now() - started, modelId: null, detail: errText(e) };
    }
    const latencyMs = Date.now() - started;
    const st = await narrator;
    if (!st.available) return { status: 'unavailable', latencyMs, modelId: null, detail: `Bedrock reachable but narration unavailable: ${st.reason ?? 'unknown'}` };
    return { status: 'ok', latencyMs, modelId: st.modelId, detail: `ListInferenceProfiles round trip in ${region}` };
  };
}

// ------------------------------------------------------------ registry + cache

let injected: HealthChecks | undefined;
let cache: { atMs: number; results: Promise<HealthCheckResults> } | null = null;

/** Tests only: replace the AWS checks (undefined restores the real ones). Clears the cache. */
export function setHealthChecks(c: HealthChecks | undefined): void {
  injected = c;
  cache = null;
}

/** Current results: injected checks run every time; the real checks are cached for HEALTH_CACHE_MS. */
export function currentHealthChecks(storeKind: () => string, env: Env = process.env, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<HealthCheckResults> {
  if (injected !== undefined) return runHealthChecks(injected, timeoutMs);
  const now = Date.now();
  if (cache !== null && now - cache.atMs < HEALTH_CACHE_MS) return cache.results;
  const results = runHealthChecks({ dynamo: dynamoCheck(env, storeKind), bedrock: bedrockCheck(env) }, timeoutMs);
  cache = { atMs: now, results };
  return results;
}
