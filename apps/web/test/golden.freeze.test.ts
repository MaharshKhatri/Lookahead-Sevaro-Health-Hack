import { body, req } from './helpers';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as viewRoute from '@/app/api/view/route';
import type { ViewDTO } from '@/lib/dto';
import { disposeStore } from '@/server/store';
import { sortKeys, subsetDiffs } from '../../../scripts/lib/freeze';

/**
 * Phase 0 golden freeze of GET /api/view at 18:20 on data/raw. Written once
 * with GOLDEN_FREEZE_WRITE=1 before the final build; afterwards every frozen
 * field must stay deep-equal (new fields may be added: additive only).
 */
const FILE = fileURLToPath(new URL('./golden/view_1820.json', import.meta.url));

/** Per-process and per-host values are not part of the frozen contract. */
function frozenView(v: ViewDTO): unknown {
  const { bootId: _b, qr: _q, ...rest } = v;
  return JSON.parse(JSON.stringify({ ...rest, dataset: { ...rest.dataset, store: undefined } }));
}

beforeAll(async () => {
  disposeStore();
  await resetRoute.POST();
});
afterAll(() => disposeStore());

describe('golden freeze: /api/view at 18:20', () => {
  it('every frozen field of the view is unchanged', async () => {
    const v = frozenView(await body<ViewDTO>(await viewRoute.GET(req('/api/view'))));
    if (process.env.GOLDEN_FREEZE_WRITE === '1' || !existsSync(FILE)) {
      writeFileSync(FILE, JSON.stringify(sortKeys(v)) + '\n');
      console.log(`wrote ${FILE}`);
    }
    const golden = JSON.parse(readFileSync(FILE, 'utf8')) as unknown;
    const diffs = subsetDiffs(v, golden);
    expect(diffs.slice(0, 20), `${diffs.length} frozen field(s) changed`).toEqual([]);
  });
});
