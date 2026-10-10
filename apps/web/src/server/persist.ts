import 'server-only';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Append-only JSONL files under data/live (Session 6 spec): every injected
 * Sevaro row (events.jsonl) and every action event (actions.jsonl). Replayed
 * on boot; cleared by POST /api/demo/reset.
 */
export const EVENTS_FILE = 'events.jsonl';
export const ACTIONS_FILE = 'actions.jsonl';

export function appendJsonl(dir: string, file: string, records: readonly unknown[]): void {
  if (records.length === 0) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, file), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

export function readJsonl<T>(dir: string, file: string): T[] {
  const path = join(dir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

export function clearLive(dir: string): void {
  for (const f of [EVENTS_FILE, ACTIONS_FILE]) rmSync(join(dir, f), { force: true });
}
