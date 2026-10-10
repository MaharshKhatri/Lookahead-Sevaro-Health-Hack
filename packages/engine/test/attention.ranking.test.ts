import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ATTENTION_WEIGHTS, detect } from '../src';
import { dataset, itemRow, report1820 } from './detect.helpers';
import { et, seededShuffle } from './helpers';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('./golden/attention_top5_1820.json', import.meta.url)), 'utf8')) as ReturnType<typeof itemRow>[];
const items = report1820().attention;

describe('brief "What Teams Must Demonstrate" #3: detect and rank what needs attention, and explain why', () => {
  it('top 5 at 18:20 match the recorded ranking (deadlocks first, then stroke critical breaches)', () => {
    expect(items.slice(0, 5).map(itemRow)).toEqual(golden);
  });

  it('every item explains itself: >= 1 why bullet, >= 1 event reference, headline <= 90 chars, score = sum of breakdown', () => {
    expect(items.length).toBeGreaterThan(10);
    for (const a of items) {
      expect(a.why.length, a.id).toBeGreaterThan(0);
      expect(a.because.length, a.id).toBeGreaterThan(0);
      expect(a.headline.length, a.id).toBeLessThanOrEqual(90);
      expect(Math.round(a.scoreBreakdown.reduce((s, f) => s + f.points, 0) * 10) / 10, a.id).toBe(a.score);
    }
  });

  it('ranking is by score, then id; stroke outranks General Neuro at equal standing', () => {
    for (let i = 1; i < items.length; i++) {
      const [a, b] = [items[i - 1]!, items[i]!];
      expect(a.score > b.score || (a.score === b.score && a.id < b.id), `${a.id} before ${b.id}`).toBe(true);
    }
    const strokeWarn = items.find((a) => a.kind === 'STANDARD_BREACH' && a.consultIds[0] === 'CON-2111')!;
    const gnWarn = items.find((a) => a.kind === 'STANDARD_BREACH' && a.consultIds[0] === 'CON-2115')!;
    expect(strokeWarn.score).toBeGreaterThan(gnWarn.score);
    expect(strokeWarn.scoreBreakdown).toContainEqual({ factor: 'stroke_at_risk', points: ATTENTION_WEIGHTS.strokeAtRisk });
  });

  it('no patient information in headlines: only ids, hospital and physician names, stages and numbers', () => {
    for (const a of items) expect(a.headline).not.toMatch(/\bpatient\b|\bage\b|year-old|\bmale\b|\bfemale\b|\bDOB\b|\bMRN\b/i);
  });

  it('ranking is identical across 20 seeded shuffles of the input order', () => {
    const baseline = items.map((a) => ({ ...a }));
    for (let seed = 1; seed <= 20; seed++) {
      const shuffled = detect({ ...dataset, events: seededShuffle(dataset.events, seed) }, et('18:20:00')).attention;
      expect(shuffled, `seed ${seed}`).toEqual(baseline);
    }
  });
});
