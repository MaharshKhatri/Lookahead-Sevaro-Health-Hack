/**
 * Seeded randomness for the engine (non-negotiable 4: "All randomness uses
 * seeded mulberry32. Same inputs give byte-identical JSON."). Nothing in
 * packages/engine/src may use unseeded randomness (CLAUDE.md rule 3).
 */
export interface Rng {
  /** Uniform in [0, 1). */
  readonly next: () => number;
  /** Exponential with the given rate (events per unit time). */
  readonly exponential: (rate: number) => number;
  /** Poisson count with the given mean (Knuth for small means, normal approximation above 500). */
  readonly poisson: (mean: number) => number;
  /** Integer in [0, n). */
  readonly int: (n: number) => number;
}

/** mulberry32 (32-bit state, period 2^32). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const exponential = (rate: number) => (rate <= 0 ? Number.POSITIVE_INFINITY : -Math.log(1 - next()) / rate);
  const poisson = (mean: number) => {
    if (mean <= 0) return 0;
    if (mean > 500) return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal(next)));
    const l = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= next();
    } while (p > l);
    return k - 1;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, exponential, poisson, int };
}

/** Standard normal via Box-Muller from one uniform source. */
function normal(next: () => number): number {
  const u = Math.max(1e-12, next());
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A 32-bit seed from a string (FNV-1a), so seeds can be named. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
