import type { Dataset, EpochMs, RawEvent } from '../types';
import { dedupe, isLate, payloadKey } from './normalize';
import { replay } from './reduce';
import { PHYSICIAN_FLAG_CODES } from './rules';
import type { ConsultState, NetworkState, PhysicianState } from './types';

export type FactValue = string | number | boolean | null;

/** One fact the system believed wrongly until a late event arrived. */
export interface Correction {
  readonly eventId: string;
  readonly entity: { readonly kind: 'physician' | 'consult'; readonly id: string };
  readonly field: string;
  readonly before: FactValue;
  readonly after: FactValue;
  /** When the wrong belief started (the event's event_time, or a retracted flag's raise time if later). */
  readonly windowStartMs: EpochMs;
  /** When it was corrected: the late event's ingested_at. */
  readonly windowEndMs: EpochMs;
  readonly windowMs: number;
}

/**
 * For every late event (OQ-12) known by `asOfMs`: replay at its ingestion
 * instant with and without it, and list every fact it changed. Comparing at
 * the same instant isolates the event from anything else ingested then.
 */
export function lateEventImpact(dataset: Dataset, asOfMs: EpochMs): Correction[] {
  const late = dedupe(dataset.events)
    .events.filter((e) => isLate(e) && e.ingestedAt <= asOfMs)
    .sort((a, b) => a.ingestedAt - b.ingestedAt || (a.eventId < b.eventId ? -1 : 1));
  return late.flatMap((e) => impactOf(dataset, e));
}

function impactOf(dataset: Dataset, late: RawEvent): Correction[] {
  const key = payloadKey(late);
  const without: Dataset = { ...dataset, events: dataset.events.filter((x) => !(x.eventId === late.eventId && payloadKey(x) === key)) };
  const before = replay(without, late.ingestedAt);
  const after = replay(dataset, late.ingestedAt);
  const out: Correction[] = [];
  const add = (kind: 'physician' | 'consult', id: string, b: Record<string, FactValue>, a: Record<string, FactValue>, flagSince: (field: string) => EpochMs | null) => {
    for (const field of new Set([...Object.keys(b), ...Object.keys(a)])) {
      const bv = b[field] ?? null;
      const av = a[field] ?? null;
      if (bv === av) continue;
      const since = bv === true && av === false ? flagSince(field) : null;
      const windowStartMs = Math.max(late.eventTime, since ?? late.eventTime);
      out.push({ eventId: late.eventId, entity: { kind, id }, field, before: bv, after: av, windowStartMs, windowEndMs: late.ingestedAt, windowMs: late.ingestedAt - windowStartMs });
    }
  };
  for (const id of entityIds(before.consults, after.consults)) {
    add('consult', id, consultFacts(before.consults[id]), consultFacts(after.consults[id]), () => null);
  }
  for (const id of entityIds(before.physicians, after.physicians)) {
    const bp = before.physicians[id];
    add('physician', id, physicianFacts(bp), physicianFacts(after.physicians[id]), (field) => flagSinceMs(bp, field));
  }
  return out;
}

function entityIds(a: NetworkState['consults'] | NetworkState['physicians'], b: NetworkState['consults'] | NetworkState['physicians']): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

function consultFacts(c: ConsultState | undefined): Record<string, FactValue> {
  if (c === undefined) return { exists: false };
  return {
    exists: true,
    stage: c.stage,
    stageEnteredMs: c.stageEnteredMs,
    assignedPhysicianId: c.assignedPhysicianId,
    open: c.open,
    contactedMs: c.contactedMs,
    noteClockStartMs: c.noteClockStartMs,
  };
}

function physicianFacts(p: PhysicianState | undefined): Record<string, FactValue> {
  if (p === undefined) return { exists: false };
  const facts: Record<string, FactValue> = {
    exists: true,
    derivedState: p.derivedState.value,
    activeVideo: p.activeVideo?.consultId ?? null,
    activeCalls: p.activeCalls.map((c) => `${c.direction}:${c.consultId ?? ''}`).join(',') || null,
    cameraActive: p.camera.active,
    agentOnline: p.agent.online,
    selfStatus: p.selfStatus.value,
    callsThisShift: p.callsThisShift,
    consultsThisShift: p.consultsThisShift,
  };
  for (const code of PHYSICIAN_FLAG_CODES) facts[`flag.${code}`] = p.flags.some((f) => f.value.code === code);
  return facts;
}

function flagSinceMs(p: PhysicianState | undefined, field: string): EpochMs | null {
  const code = field.startsWith('flag.') ? field.slice('flag.'.length) : null;
  return p?.flags.find((f) => f.value.code === code)?.value.sinceMs ?? null;
}
