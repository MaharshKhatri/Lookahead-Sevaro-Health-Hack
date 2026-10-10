import 'server-only';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Where the Sevaro data package and the live (appended) logs live.
 * LOOKAHEAD_DATA_DIR / LOOKAHEAD_LIVE_DIR override; otherwise the repo root is
 * found by walking up from the working directory to pnpm-workspace.yaml.
 */
export function repoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export const dataDir = (): string => process.env.LOOKAHEAD_DATA_DIR ?? join(repoRoot(), 'data', 'raw');
export const liveDir = (): string => process.env.LOOKAHEAD_LIVE_DIR ?? join(repoRoot(), 'data', 'live');
