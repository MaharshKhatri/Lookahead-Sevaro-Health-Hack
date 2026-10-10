import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Route-test harness: a fresh temp data/live per test file, so tests never
 * touch the repo's data/live. Must be imported before any server module.
 */
export const LIVE_DIR = mkdtempSync(join(tmpdir(), 'lookahead-live-'));
process.env.LOOKAHEAD_LIVE_DIR = LIVE_DIR;
delete process.env.LOOKAHEAD_PUBLIC_ORIGIN;

export const DATA_DIR = fileURLToPath(new URL('../../../data/raw/', import.meta.url));
process.env.LOOKAHEAD_DATA_DIR = DATA_DIR;

export const BASE = 'http://localhost:3000';

export function req(path: string, init: RequestInit & { role?: string; actorId?: string; cookie?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.role !== undefined) headers.set('x-lookahead-role', init.role);
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  if (init.actorId !== undefined) headers.set('x-lookahead-actor-id', init.actorId);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { ...init, headers });
}

export async function body<T = Record<string, unknown>>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

/** The last data row of the real event_stream.csv (a known duplicate when re-sent). */
export function lastStreamRow(): string {
  const lines = readFileSync(join(DATA_DIR, 'event_stream.csv'), 'utf8').trim().split(/\r?\n/);
  return lines.at(-1) ?? '';
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
