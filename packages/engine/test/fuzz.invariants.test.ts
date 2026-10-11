import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  SELF_REPORTED_STATUSES,
  appendEventText,
  applyCommand,
  assertNoPHI,
  decide,
  IN_FLIGHT,
  foldOffers,
  isoWeekStartEt,
  statusOf,
  offerLogEntries,
  replay,
  type ActContext,
  type ActionLog,
  type ActorRef,
  type Command,
  type DecisionReport,
  type EventType,
} from '../src';
import { MAX_OFFERS_PER_WEEK, MAX_OPEN_OFFERS_PER_PHYSICIAN } from '../src/decide/brief-rules';
import { COORD, LEAD, SYSTEM, phys, twoEligible } from './act.helpers';
import { dataset } from './detect.helpers';
import { et, seededRandom, seededShuffle } from './helpers';

/**
 * Seeded property tests. Random but schema-valid event streams (brief
 * "Synthetic Dataset" event types and description conventions, OQ-14) are
 * appended through the live path and must never break the engine's invariants
 * (D-19: "Bad sequences never throw"). Then random command sequences must keep
 * the Act layer's safety constraints (brief "Notification and Safety
 * Constraints"). Everything is reproducible from the seed (CLAUDE.md rule 3).
 */

const SEEDS = 50;
const EVENTS_PER_SEED = 500;
const ACT_SEEDS = 5;
const COMMANDS_PER_SEED = 60;

// The reference stream's blank-column pattern per event type (D-26, docs/DATA_PROFILE.md).
const NO_CONSULT: ReadonlySet<EventType> = new Set(['physician_status_changed', 'camera_active', 'camera_inactive', 'agent_heartbeat_lost', 'shift_started']);
const NO_PHYSICIAN: ReadonlySet<EventType> = new Set(['consult_received', 'consult_triaged', 'routing_attempt_failed']);

const physicianIds = [...dataset.physiciansOnShift, ...dataset.offShiftRoster].map((p) => p.physicianId);
const hospitalIds = dataset.hospitals.map((h) => h.hospitalId);
const existingConsults = [...new Set(dataset.events.map((e) => e.consultId).filter((c): c is string => c !== null))];
const newConsults = Array.from({ length: 40 }, (_, i) => `CON-${95001 + i}`); // test-only ids
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function pick<T>(rand: () => number, items: readonly T[]): T {
  const x = items[Math.floor(rand() * items.length)];
  if (x === undefined) throw new Error('empty pick');
  return x;
}

/** One random, schema-valid event_stream.csv row (UTC "Z" offsets are explicit offsets too). */
function randomRow(rand: () => number, i: number): string {
  const type = pick(rand, EVENT_TYPES);
  const eventTime = et('07:00:00') + Math.floor(rand() * 13 * 3600) * 1000;
  const ingested = eventTime + Math.floor(rand() * 601) * 1000;
  const consultId = NO_CONSULT.has(type) ? '' : rand() < 0.7 ? pick(rand, existingConsults) : pick(rand, newConsults);
  const physicianId = NO_PHYSICIAN.has(type) ? '' : pick(rand, physicianIds);
  const hospitalId = type === 'consult_received' || rand() < 0.5 ? pick(rand, hospitalIds) : '';
  let description = 'fuzz';
  if (type === 'consult_received') description = rand() < 0.5 ? 'Stroke consult request received' : 'General Neuro consult request received';
  else if (type === 'physician_status_changed') description = `Self-reported status: ${pick(rand, SELF_REPORTED_STATUSES)}`;
  else if ((type === 'incoming_call_ended' || type === 'outgoing_call_ended') && rand() < 0.2) description = 'Call ended; phone-only consult';
  return `FZ-${String(i).padStart(5, '0')},${iso(eventTime)},${iso(ingested)},${consultId},${type},${physicianId},${hospitalId},${description}`;
}

function checkInvariants(d: DecisionReport, label: string): void {
  const state = d.detection.state;
  for (const c of Object.values(state.consults)) {
    if (c.open && c.receivedMs !== null) {
      expect(c.stage, `${label} ${c.consultId} stage`).not.toBeNull();
      expect(c.stageHistory.length, `${label} ${c.consultId} history`).toBeGreaterThan(0);
    }
    if (c.stage !== null) expect(c.stageHistory.at(-1)?.stage, `${label} ${c.consultId} last stage`).toBe(c.stage);
    // D-19: a consult first seen through a later event is tracked with a warning that names it.
    if (c.receivedMs === null) expect(state.integrity.warnings.some((w) => w.includes(c.consultId) && w.includes('before any consult_received')), `${label} ${c.consultId} warning`).toBe(true);
    if (!c.open) expect(c.stage, `${label} ${c.consultId} closed stage`).toBe('Signed Off');
  }
  for (const p of Object.values(state.physicians)) {
    expect(p.consultsThisShift, `${label} ${p.physicianId} consults`).toBeGreaterThanOrEqual(0);
    expect(p.callsThisShift, `${label} ${p.physicianId} calls`).toBeGreaterThanOrEqual(0);
    for (const id of p.openConsultIds) expect(state.consults[id]?.open, `${label} ${p.physicianId} open ${id}`).toBe(true);
  }
  const cov = d.detection.coverage;
  for (const point of cov.timeline) {
    for (const [h, x] of Object.entries(point.perHospital)) {
      expect(x.required, `${label} ${h} required`).toBeGreaterThanOrEqual(0);
      expect(x.staffed, `${label} ${h} staffed`).toBeGreaterThanOrEqual(0);
      expect(x.staffedConfirmed + x.staffedExpected, `${label} ${h} confirmed+expected`).toBe(x.staffed);
      expect(x.staffedIds, `${label} ${h} ids`).toHaveLength(x.staffed);
    }
  }
  for (const g of cov.gaps) expect(g.staffedConfirmed + g.staffedExpected).toBe(g.staffed);
  for (const h of hospitalIds) {
    const ids = cov.routableNowIds[h] ?? [];
    expect(cov.routableNow[h], `${label} ${h} routableNow`).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(0);
    for (const id of ids) expect(state.physicians[id]?.selfStatus.value, `${label} ${h} ${id} routable while Temporarily Unavailable`).not.toBe('Temporarily Unavailable');
  }
  const ids = d.detection.attention.map((a) => a.id);
  expect(new Set(ids).size, `${label} attention ids unique`).toBe(ids.length);
  for (const a of d.detection.attention) {
    expect(a.scoreBreakdown.reduce((s, f) => s + f.points, 0), `${label} ${a.id} score`).toBeCloseTo(a.score, 5);
    expect(a.score).toBeGreaterThanOrEqual(0);
  }
  for (const n of d.needs) if (n.endMs !== 'beyond_horizon') expect(n.endMs, `${label} need ${n.id}`).toBeGreaterThan(n.startMs);
  for (const e of d.ledger) expect(e.eligible, `${label} ledger ${e.physicianId}`).toBe(e.rules.every((r) => r.pass !== false));
  if (d.recommendedOffer !== null) assertNoPHI(d.recommendedOffer.message);
}

describe('fuzz: random valid event streams never break replay/detect/decide invariants (D-19, OQ-24, OQ-29)', () => {
  it(`${SEEDS} seeds x ${EVENTS_PER_SEED} events, evaluated at 18:20 and 19:30`, () => {
    let totalAccepted = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = seededRandom(seed);
      const rows = seededShuffle(Array.from({ length: EVENTS_PER_SEED }, (_, i) => randomRow(rand, i)), seed);
      const r = appendEventText(dataset, rows.join('\n'), { nowMs: et('18:20:00') });
      expect(r.rejected, `seed ${seed} rejected`).toEqual([]);
      expect(r.accepted.length + r.duplicates.length, `seed ${seed} accepted+dupes`).toBe(EVENTS_PER_SEED);
      totalAccepted += r.accepted.length;
      for (const hms of ['18:20:00', '19:30:00']) {
        const now = et(hms);
        expect(() => replay(r.dataset, now), `seed ${seed} replay ${hms}`).not.toThrow();
        let d: DecisionReport | null = null;
        expect(() => {
          d = decide(r.dataset, now);
        }, `seed ${seed} decide ${hms}`).not.toThrow();
        if (d !== null) checkInvariants(d, `seed ${seed} ${hms}`);
      }
    }
    expect(totalAccepted).toBeGreaterThan(SEEDS * EVENTS_PER_SEED * 0.9);
  }, 60_000);

  it('is deterministic: the same seed yields the same attention ids and need ids', () => {
    const build = () => {
      const rand = seededRandom(11);
      const rows = seededShuffle(Array.from({ length: 200 }, (_, i) => randomRow(rand, i)), 11);
      return decide(appendEventText(dataset, rows.join('\n'), { nowMs: et('18:20:00') }).dataset, et('18:20:00'));
    };
    const a = build();
    const b = build();
    expect(a.detection.attention.map((x) => [x.id, x.score])).toEqual(b.detection.attention.map((x) => [x.id, x.score]));
    expect(a.needs.map((n) => n.id)).toEqual(b.needs.map((n) => n.id));
  });
});

// ---------------------------------------------------------------- Act layer

type Outcome = { readonly ok: boolean; readonly code: string | null };

function randomCommand(rand: () => number, log: ActionLog, nowMs: number, i: number, seed: number): Command {
  const commandId = rand() < 0.05 && i > 0 ? `s${seed}-c${Math.floor(rand() * i)}` : `s${seed}-c${i}`; // 5%: retry an earlier commandId (idempotency)
  const offers = foldOffers(log, nowMs);
  const offerId = offers.length > 0 && rand() < 0.9 ? pick(rand, offers).offerId : 'off-nope';
  const roster = dataset.offShiftRoster.map((p) => p.physicianId);
  const anyPhysician = rand() < 0.85 ? pick(rand, roster) : pick(rand, physicianIds);
  const actors: ActorRef[] = [COORD, LEAD, SYSTEM, phys(anyPhysician)];
  const actor = rand() < 0.75 ? null : pick(rand, actors); // mostly the right actor, sometimes a random one
  const escalations = log.flatMap((e) => (e.type === 'escalation_raised' ? [e.payload.escalationId] : []));
  const consults = existingConsults;
  switch (Math.floor(rand() * 11)) {
    case 0:
    case 1:
      return { type: 'proposeOffer', commandId, actor: actor ?? COORD, physicianId: anyPhysician };
    case 2:
      return { type: 'approveOffer', commandId, actor: actor ?? LEAD, offerId };
    case 3:
      return { type: 'rejectOffer', commandId, actor: actor ?? LEAD, offerId, reason: 'fuzz' };
    case 4:
    case 5: {
      const target = offers.find((o) => o.offerId === offerId)?.proposal.physicianId ?? anyPhysician;
      const who = rand() < 0.8 ? target : anyPhysician;
      return { type: 'respond', commandId, actor: actor ?? phys(who), offerId, physicianId: who, response: rand() < 0.6 ? 'accept' : 'decline' };
    }
    case 6:
      return { type: 'cancelOffer', commandId, actor: actor ?? (rand() < 0.5 ? COORD : LEAD), offerId, reason: 'fuzz cancel' };
    case 7:
      return { type: 'tick', commandId, actor: actor ?? SYSTEM };
    case 8:
      return { type: 'raiseEscalation', commandId, actor: actor ?? COORD, subject: { hospitalIds: [pick(rand, hospitalIds)] }, reason: 'fuzz escalation' };
    case 9:
      return escalations.length > 0 && rand() < 0.7
        ? { type: 'authorizeEscalation', commandId, actor: actor ?? LEAD, escalationId: pick(rand, escalations) }
        : { type: 'proposeSlot', commandId, actor: actor ?? COORD };
    default:
      return { type: 'requestReassignment', commandId, actor: actor ?? COORD, consultId: pick(rand, consults), toPhysicianId: pick(rand, physicianIds) };
  }
}

function checkActInvariants(log: ActionLog, nowMs: number, label: string): void {
  log.forEach((e, i) => expect(e.seq, `${label} seq`).toBe(i + 1));
  const inFlight = foldOffers(log, nowMs).filter((r) => IN_FLIGHT.includes(statusOf(r, nowMs)));
  const perPhysician = new Map<string, number>();
  for (const r of inFlight) perPhysician.set(r.proposal.physicianId, (perPhysician.get(r.proposal.physicianId) ?? 0) + 1);
  for (const [p, n] of perPhysician) expect(n, `${label} open offers for ${p}`).toBeLessThanOrEqual(MAX_OPEN_OFFERS_PER_PHYSICIAN);
  const weekStart = isoWeekStartEt(nowMs);
  const weekly = new Map<string, number>();
  for (const o of offerLogEntries(log, nowMs)) if (o.sentMs >= weekStart && o.sentMs <= nowMs) weekly.set(o.physicianId, (weekly.get(o.physicianId) ?? 0) + 1);
  for (const [p, n] of weekly) expect(n, `${label} weekly offers for ${p}`).toBeLessThanOrEqual(MAX_OFFERS_PER_WEEK);
  for (const e of log) {
    if (e.type !== 'offer_sent') continue;
    const approved = log.find((x) => x.type === 'offer_approved' && x.payload.offerId === e.payload.offerId);
    expect(approved, `${label} ${e.payload.offerId} approval`).toBeDefined();
    expect((approved?.seq ?? Infinity) < e.seq, `${label} ${e.payload.offerId} approved before sent`).toBe(true);
    expect(() => assertNoPHI(e.payload.message), `${label} ${e.payload.offerId} PHI`).not.toThrow();
  }
}

describe('fuzz: random command sequences keep the Act safety constraints (brief "Notification and Safety Constraints")', () => {
  it(`${ACT_SEEDS} seeds x ${COMMANDS_PER_SEED} commands from 18:21, sequential and parallel dispatch`, () => {
    const tally = new Map<string, number>();
    for (let seed = 1; seed <= ACT_SEEDS; seed++) {
      const rand = seededRandom(100 + seed);
      const ctx: ActContext = { dataset: twoEligible, dispatchMode: seed % 2 === 0 ? 'parallel' : 'sequential' };
      let log: ActionLog = [];
      let nowMs = et('18:21:00');
      for (let i = 0; i < COMMANDS_PER_SEED; i++) {
        nowMs += Math.floor(rand() * 61) * 1000;
        const cmd = randomCommand(rand, log, nowMs, i, seed);
        let out: Outcome = { ok: false, code: 'THREW' };
        const prev = log;
        expect(() => {
          const r = applyCommand(ctx, log, cmd, nowMs);
          out = { ok: r.ok, code: r.ok ? (r.replayed ? 'REPLAYED' : 'OK') : r.code };
          if (r.ok) {
            // Append-only: the previous events are the same objects, in the same order.
            expect(r.log.slice(0, prev.length).every((e, k) => e === prev[k]), `seed ${seed} cmd ${i} prefix`).toBe(true);
            if (r.replayed) expect(r.log, `seed ${seed} cmd ${i} replay appends nothing`).toBe(prev);
            else expect(r.log.length, `seed ${seed} cmd ${i} growth`).toBe(prev.length + r.emitted.length);
            log = r.log;
          }
        }, `seed ${seed} cmd ${i} ${cmd.type}`).not.toThrow();
        tally.set(`${cmd.type}:${out.code}`, (tally.get(`${cmd.type}:${out.code}`) ?? 0) + 1);
        checkActInvariants(log, nowMs, `seed ${seed} cmd ${i}`);
      }
      expect(log.length, `seed ${seed} produced actions`).toBeGreaterThan(0);
    }
    // The random walk actually exercised the loop: offers were proposed, approved and answered.
    expect(tally.get('proposeOffer:OK') ?? 0).toBeGreaterThan(0);
    expect(tally.get('approveOffer:OK') ?? 0).toBeGreaterThan(0);
    expect(tally.get('respond:OK') ?? 0).toBeGreaterThan(0);
    expect([...tally.keys()].some((k) => k.endsWith(':FORBIDDEN_ROLE'))).toBe(true);
    expect([...tally.keys()].some((k) => k.endsWith(':THREW'))).toBe(false);
  }, 60_000);
});
