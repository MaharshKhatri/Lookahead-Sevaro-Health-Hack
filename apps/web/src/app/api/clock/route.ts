import { requireDemoControl } from '@/server/auth';
import { guard, json, readJson } from '@/server/http';
import { SPEEDS, StoreError, getReadyStore, type ClockAction } from '@/server/store';
import type { ClockSpeed } from '@/lib/dto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const speedOf = (v: unknown): ClockSpeed | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === 'number' && (SPEEDS as readonly number[]).includes(v)) return v as ClockSpeed;
  throw new StoreError('BAD_REQUEST', `speed must be one of ${SPEEDS.join(', ')}`);
};
const num = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new StoreError('BAD_REQUEST', `${name} must be a number`);
};

/**
 * POST /api/clock {action: set|play|pause|advance|jump}. set {nowMs?, speed?};
 * play {speed?}; advance {minutes?, seconds?}; jump {to: "HH:mm[:ss]" ET}.
 * Every move runs a system tick so offer expiries are materialized (OQ-36).
 * D-91: open in DEMO_MODE, else a coordinator/admin session is required.
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    requireDemoControl(req);
    const b = await readJson(req);
    let a: ClockAction;
    switch (b.action) {
      case 'set':
        a = { action: 'set', ...(b.nowMs === undefined ? {} : { nowMs: num(b.nowMs, 'nowMs') }), ...(b.speed === undefined ? {} : { speed: speedOf(b.speed) }) } as ClockAction;
        break;
      case 'play':
        a = { action: 'play', ...(b.speed === undefined ? {} : { speed: speedOf(b.speed) }) } as ClockAction;
        break;
      case 'pause':
        a = { action: 'pause' };
        break;
      case 'advance':
        a = { action: 'advance', ...(b.minutes === undefined ? {} : { minutes: num(b.minutes, 'minutes') }), ...(b.seconds === undefined ? {} : { seconds: num(b.seconds, 'seconds') }) } as ClockAction;
        break;
      case 'jump':
        if (typeof b.to !== 'string') throw new StoreError('BAD_REQUEST', 'jump needs {to: "HH:mm"} (ET)');
        a = { action: 'jump', to: b.to };
        break;
      default:
        throw new StoreError('BAD_REQUEST', 'action must be one of set, play, pause, advance, jump');
    }
    const store = await getReadyStore();
    const clock = await store.moveClock(a);
    const s = store.snapshot();
    return json({ ok: true, clock, version: s.version, logSeq: s.log.at(-1)?.seq ?? 0 });
  });
}
