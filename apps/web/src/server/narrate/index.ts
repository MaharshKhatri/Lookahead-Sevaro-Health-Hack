import 'server-only';
import { createHash } from 'node:crypto';
import type { ViewDTO } from '@/lib/dto';
import { getNarrator } from './bedrock';
import { factsFor, type NarrationFacts, type NarrationKind } from './facts';
import { MAX_WORDS, checkNarration, templateNarration, type GuardCheck } from './guard';

export type { NarrationKind } from './facts';

/**
 * POST /api/narrate: a 2-3 sentence plain-English briefing of engine facts.
 * Never a decision: the model gets only the facts JSON and the result passes
 * the fidelity guard or is replaced by the deterministic template.
 */

export interface Narration {
  readonly text: string;
  readonly source: 'bedrock' | 'template';
  readonly checks: readonly GuardCheck[];
  readonly modelId: string | null;
  /** Why the template was served (unavailable, timeout, guard failure). */
  readonly fallbackReason: string | null;
  readonly facts: NarrationFacts;
}

export const SYSTEM_PROMPT = [
  'You write short operational briefings for a tele-neurology operations team.',
  'Use ONLY the facts in the JSON you are given. Do not add numbers, times, names or causes that are not in it.',
  'No clinical advice. No patient details. Do not mention consult or event identifiers.',
  `Write 2 or 3 plain sentences, at most ${MAX_WORDS} words in total. Write clock times exactly as given (24-hour, ET).`,
  'Do not tell the reader what to decide; describe the situation and the recommendation as stated in the facts.',
].join(' ');

const cache = new Map<string, Narration>();

/** Tests and dataset swaps: forget cached narrations. */
export function clearNarrationCache(): void {
  cache.clear();
}

const hash = (f: NarrationFacts) => createHash('sha256').update(JSON.stringify(f)).digest('hex').slice(0, 16);

export async function narrate(view: ViewDTO, datasetVersion: number, kind: NarrationKind, id: string): Promise<Narration | null> {
  const facts = factsFor(view, kind, id);
  if (facts === null) return null;
  const key = `${view.dataset.key}|${datasetVersion}|${kind}|${id}|${hash(facts)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const result = await generate(facts);
  if (cache.size > 500) cache.clear();
  // Only cache successes and guard failures; a transient outage should be retried next time.
  if (result.source === 'bedrock' || result.fallbackReason?.startsWith('guard') === true) cache.set(key, result);
  return result;
}

export async function generate(facts: NarrationFacts): Promise<Narration> {
  const template = templateNarration(facts);
  const fallback = (reason: string, modelId: string | null, checks?: readonly GuardCheck[]): Narration => ({
    text: template,
    source: 'template',
    checks: checks ?? checkNarration(template, facts),
    modelId,
    fallbackReason: reason,
    facts,
  });
  let out: { text: string; modelId: string };
  try {
    out = await getNarrator().generate(SYSTEM_PROMPT, JSON.stringify({ title: facts.title, facts: facts.points, names: facts.names }));
  } catch (e) {
    const name = (e as { name?: string }).name;
    return fallback(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : `unavailable: ${e instanceof Error ? e.message : String(e)}`, null);
  }
  const checks = checkNarration(out.text, facts);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) return fallback(`guard: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}`, out.modelId, checks);
  return { text: out.text, source: 'bedrock', checks, modelId: out.modelId, fallbackReason: null, facts };
}
