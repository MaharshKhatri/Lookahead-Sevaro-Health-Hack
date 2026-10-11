import 'server-only';
import { DEMAND_SPIKE_WINDOW_MS, buildForecastModel, forecast, replay, type ActContext, type Dataset, type HawkesFit, type NetworkState } from '@lookahead/engine';
import type { SurgeForecastDTO } from '@/lib/dto';
import type { StoreSnapshot } from './store';

/**
 * Surge forecast for the web layer (Phase 7). The Hawkes fit (~90 ms, D-85)
 * is memoized by (bootId, datasetVersion, minute of the sim clock): the fit
 * depends only on the arrivals known at t, which change when Sevaro rows are
 * injected or the dataset is swapped (datasetVersion) or when the clock moves
 * to another minute. The memoized fit is handed to the engine both for the
 * view (`forecastFor`) and for standby commands (`actContext`, store.ts), so
 * a command and the view it produced agree on the forecast. Engine code stays
 * pure; this module only caches.
 */

const FIT_MEMO_SIZE = 8;
const fits: { key: string; fit: HawkesFit }[] = [];

export const fitKey = (bootId: string, datasetVersion: number, nowMs: number): string => `${bootId}|${datasetVersion}|${Math.floor(nowMs / 60_000)}`;

export function memoizedFit(key: string): HawkesFit | undefined {
  return fits.find((f) => f.key === key)?.fit;
}

export function rememberFit(key: string, fit: HawkesFit): void {
  if (fits.some((f) => f.key === key)) return;
  fits.unshift({ key, fit });
  fits.length = Math.min(fits.length, FIT_MEMO_SIZE);
}

/** Test hook: how many fits are memoized. */
export const fitMemoSize = (): number => fits.length;

/** The ActContext for store.command(): the memoized fit when one exists for this version and minute (the engine refits otherwise). */
export function actContext(dataset: Dataset, bootId: string, datasetVersion: number, nowMs: number): ActContext {
  const fit = memoizedFit(fitKey(bootId, datasetVersion, nowMs));
  return fit === undefined ? { dataset } : { dataset, forecastFit: fit };
}

/** The fit for a snapshot: memo hit, else a replay + fit remembered for the next caller. */
export function fitFor(s: StoreSnapshot, state?: NetworkState): HawkesFit {
  const key = fitKey(s.bootId, s.datasetVersion, s.clock.nowMs);
  const hit = memoizedFit(key);
  if (hit !== undefined) return hit;
  const st = state ?? replay(s.dataset, s.clock.nowMs);
  const fit = buildForecastModel(s.dataset, st, s.clock.nowMs).fit;
  rememberFit(key, fit);
  return fit;
}

/**
 * The engine's SurgeForecast plus, per hospital, the observed consult_received
 * counts per 15-min bucket over the last 180 min (knowledge-time replay: only
 * consults whose receipt is known at t), for the radar's history bars.
 */
export function forecastFor(s: StoreSnapshot, state: NetworkState, fit: HawkesFit): SurgeForecastDTO {
  const nowMs = s.clock.nowMs;
  const f = forecast(s.dataset, state, nowMs, { fit });
  const past = pastBuckets(state, nowMs);
  return {
    schemaVersion: f.schemaVersion,
    asOfMs: f.asOfMs,
    dayStartMs: f.dayStartMs,
    params: f.params,
    pastBucketMin: PAST_BUCKET_MIN,
    pastWindowMin: PAST_WINDOW_MIN,
    hospitals: f.hospitals.map((h) => ({ ...h, past: past.get(h.hospitalId) ?? emptyPast(nowMs) })),
  };
}

export const PAST_BUCKET_MIN = 15;
export const PAST_WINDOW_MIN = 180;
const BUCKET_MS = PAST_BUCKET_MIN * 60_000;

function emptyPast(nowMs: number): { startMs: number; count: number }[] {
  const out: { startMs: number; count: number }[] = [];
  for (let k = PAST_WINDOW_MIN / PAST_BUCKET_MIN; k >= 1; k--) out.push({ startMs: nowMs - k * BUCKET_MS, count: 0 });
  return out;
}

/** Buckets end at now and step back 15 min (the last bucket is (now-15, now], matching the trailing-60 window's end). */
function pastBuckets(state: NetworkState, nowMs: number): Map<string, { startMs: number; count: number }[]> {
  const out = new Map<string, { startMs: number; count: number }[]>();
  const windowStart = nowMs - PAST_WINDOW_MIN * 60_000;
  for (const c of Object.values(state.consults)) {
    if (c.receivedMs === null || c.hospitalId === null || c.receivedMs > nowMs || c.receivedMs <= windowStart) continue;
    const buckets = out.get(c.hospitalId) ?? emptyPast(nowMs);
    out.set(c.hospitalId, buckets);
    const idx = Math.min(buckets.length - 1, Math.floor((c.receivedMs - windowStart - 1) / BUCKET_MS));
    const b = buckets[idx];
    if (b !== undefined) b.count++;
  }
  return out;
}

/** The brief's spike window in minutes, for the radar's axis label. */
export const SPIKE_WINDOW_MIN = DEMAND_SPIKE_WINDOW_MS / 60_000;
