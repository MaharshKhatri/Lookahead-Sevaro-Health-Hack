import { describe, expect, it } from 'vitest';
import {
  STANDBY_ACCEPT_BASE,
  STANDBY_ACCEPT_DECLINE_PENALTY,
  STANDBY_MIN_WINDOW_MIN,
  acceptedOffersOf,
  activationRecommended,
  activationMessage,
  applyCommand,
  buildForecastModel,
  buildStandbyPlan,
  decide,
  findPhiViolations,
  foldStandbys,
  greedySelectFrom,
  listOffers,
  offerLogEntries,
  planWithLog,
  preAlertMessage,
  releaseMessage,
  setValue,
  standbyStatus,
  standDownRecommended,
  type ActionLog,
  type Command,
  type GapCell,
  type SelectableCandidate,
  type StandbyWindow,
} from '../src';
import { mulberry32 } from '../src/util/rng';
import { COORD, LEAD, ctx, dataset, must, phys, run } from './act.helpers';
import { et, seededShuffle } from './helpers';

/**
 * Phase 4: Standby Neurologist Network. Brief: "bring an off-shift physician
 * online for a few hours to cover a gap" (The Challenge), eligibility rules
 * ("Coverage and Split-Shift Eligibility"), approval and PHI constraints
 * ("Notification and Safety Constraints"), roles ("Users and Decision Rights").
 */

const NOW = et('18:20:00');
const d0 = decide(dataset, NOW);
const model0 = buildForecastModel(dataset, d0.detection.state, NOW);
const plan0 = buildStandbyPlan({ dataset, decision: d0, model: model0, nowMs: NOW });

describe('4.1 gap probability grid (uses the existing projection; never reimplements it)', () => {
  it('cells are 15-min slots from the next quarter hour to +180, one per hospital, with P(gap) in [0,1] and the deterministic term winning', () => {
    const starts = [...new Set(plan0.cells.map((c) => c.startMs))].sort((a, b) => a - b);
    expect(starts[0]).toBe(et('18:30:00'));
    expect(starts.at(-1)).toBe(et('21:15:00'));
    expect(starts.length).toBe(12);
    expect(plan0.cells.length).toBe(12 * dataset.hospitals.length);
    for (const c of plan0.cells) {
      expect(c.pGap).toBeGreaterThanOrEqual(0);
      expect(c.pGap).toBeLessThanOrEqual(1);
      expect(c.pGap).toBeCloseTo(Math.max(c.pDeterministic, c.pProbabilistic), 9);
      if (c.existingClass === 'HARD_GAP' || c.existingClass === 'DEADLOCK') expect(c.pGap).toBe(1);
      if (c.supply < c.requiredBase) expect(c.pProbabilistic).toBe(1);
      if (c.supply > c.requiredBase) expect(c.pProbabilistic).toBe(0);
      expect(c.staffedConfirmed + c.staffedExpected).toBe(c.supply);
    }
  });

  it('the deadlocked hospitals at 18:20 have P(gap) = 1 in their first cells and the surging hospital has the largest EUM', () => {
    const deadlocked = new Set(d0.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => n.hospitalId));
    expect(deadlocked.size).toBeGreaterThan(0);
    for (const h of deadlocked) {
      const first = plan0.cells.find((c) => c.hospitalId === h);
      expect(first?.existingClass).toBe('DEADLOCK');
      expect(first?.pGap).toBe(1);
    }
    const surge = d0.detection.demand.find((x) => x.spike)?.hospitalId;
    const top = [...plan0.hospitals].sort((a, b) => b.eum - a.eum)[0];
    expect(top?.hospitalId).toBe(surge);
    expect(plan0.totalEUM).toBeCloseTo(plan0.hospitals.reduce((s, h) => s + h.eum, 0), 6);
  });
});

describe('4.2 candidates: eligibility parity with the split-shift ledger', () => {
  it('every off-shift physician is listed; a physician eligible for the split-shift offer is a standby candidate, and each ineligible one names a failing rule', () => {
    expect(plan0.candidates.map((c) => c.physicianId)).toEqual(dataset.offShiftRoster.map((r) => r.physicianId));
    for (const e of d0.ledger) {
      const c = plan0.candidates.find((x) => x.physicianId === e.physicianId);
      expect(c).toBeDefined();
      if (e.eligible) expect(c?.eligible, `${e.physicianId} eligible in the ledger`).toBe(true);
      if (!c?.eligible) expect(c?.failingRule?.rule).toBeTruthy();
    }
    // Rules that do not depend on which hospitals are at risk agree exactly (opt-in, rest, hours, overlap).
    for (const e of d0.ledger) {
      const c = plan0.candidates.find((x) => x.physicianId === e.physicianId);
      for (const rule of ['ELIG_OPT_IN', 'ELIG_REST_10H', 'ELIG_HOURS_60', 'ELIG_NO_SCHEDULE_OVERLAP']) {
        const failed = e.rules.find((r) => r.rule === rule)?.pass === false;
        if (failed) expect(c?.eligible).toBe(false);
      }
    }
    // The standby window honours the brief's 2-hour minimum.
    for (const c of plan0.candidates.filter((x) => x.eligible)) expect(c.window?.minutes ?? 0).toBeGreaterThanOrEqual(STANDBY_MIN_WINDOW_MIN);
    const sole = d0.ledger.filter((e) => e.eligible).map((e) => e.physicianId);
    expect(plan0.selected[0]?.physicianId).toBe(sole[0]);
  });

  it('pAccept and burden are the illustrative roster-decline formulas', () => {
    for (const c of plan0.candidates) {
      expect(c.pAccept).toBeCloseTo(STANDBY_ACCEPT_BASE / (1 + STANDBY_ACCEPT_DECLINE_PENALTY * c.declined30d), 3);
      expect(c.burden).toBeCloseTo(1 + 0.2 * c.declined30d, 3);
    }
  });
});

describe('4.3 greedy probabilistic coverage vs brute force', () => {
  const win: StandbyWindow = { startMs: 0, endMs: 10, minutes: 600, startReason: 'approval_plus_online', endReason: 'horizon' };
  const cell = (h: string, t: number, p: number): GapCell => ({
    hospitalId: h,
    hospitalName: h,
    startMs: t,
    endMs: t + 1,
    supply: 1,
    staffedConfirmed: 1,
    staffedExpected: 0,
    requiredBase: 1,
    existingClass: 'OK',
    pDeterministic: 0,
    pProbabilistic: p,
    pSpike: p,
    pGap: p,
    coverableByOne: true,
    rule: 'DEMAND_SPIKE_TRAILING_60',
  });
  const cand = (id: string, hospitals: string[], pAccept: number, burden = 1): SelectableCandidate => ({
    physicianId: id,
    name: id,
    eligible: true,
    window: win,
    pAccept,
    burden,
    declined30d: 0,
    covers: (c) => hospitals.includes(c.hospitalId),
  });
  const brute = (cells: GapCell[], cands: SelectableCandidate[], k: number) => {
    let best = 0;
    const n = cands.length;
    for (let mask = 0; mask < 1 << n; mask++) {
      const set = cands.filter((_, i) => mask & (1 << i));
      if (set.length > k) continue;
      best = Math.max(best, setValue(cells, new Map(), set));
    }
    return best;
  };

  it('on 200 seeded small cases the greedy set is within (1 - 1/e) of the optimum, and matches it on an obvious case', () => {
    const obviousCells = [cell('A', 0, 1), cell('A', 1, 1), cell('B', 0, 1)]; // B's gain 12 EUM clears STANDBY_MIN_GAIN_EUM
    const obvious = greedySelectFrom(obviousCells, new Map(), [cand('p1', ['A'], 0.8), cand('p2', ['B'], 0.8)]);
    expect(obvious.map((s) => s.physicianId)).toEqual(['p1', 'p2']);
    expect(obvious.reduce((s, x) => s + x.valueEUM, 0)).toBeCloseTo(setValue(obviousCells, new Map(), [cand('p1', ['A'], 0.8), cand('p2', ['B'], 0.8)]), 0);
    const rng = mulberry32(7);
    let ties = 0;
    for (let i = 0; i < 200; i++) {
      const hospitals = ['A', 'B', 'C', 'D'];
      const cells = hospitals.flatMap((h) => [0, 1, 2, 3].map((t) => cell(h, t, Math.round(rng.next() * 100) / 100)));
      const cands = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => cand(id, hospitals.filter(() => rng.next() < 0.5), 0.4 + 0.5 * rng.next()));
      const greedy = greedySelectFrom(cells, new Map(), cands);
      const value = setValue(cells, new Map(), cands.filter((c) => greedy.some((g) => g.physicianId === c.physicianId)));
      const opt = brute(cells, cands, 3);
      // The greedy stops under STANDBY_MIN_GAIN_EUM, so compare against the best set of the same size or smaller when it stopped early.
      const bound = greedy.length === 3 ? opt : brute(cells, cands, Math.max(1, greedy.length));
      expect(value, `case ${i}`).toBeGreaterThanOrEqual((1 - 1 / Math.E) * bound - 1e-9);
      if (Math.abs(value - opt) < 1e-9) ties++;
    }
    expect(ties).toBeGreaterThan(50); // the greedy hits the exact optimum on most small cases; the (1 - 1/e) bound is what it guarantees
  });

  it('ties prefer lower burden (physician fairness 4.5)', () => {
    const cells = [cell('A', 0, 1)];
    const sel = greedySelectFrom(cells, new Map(), [cand('p1', ['A'], 0.8, 1.4), cand('p2', ['A'], 0.8, 1.0)]);
    expect(sel[0]?.physicianId).toBe('p2');
  });
});

describe('4.4 lifecycle through the command processor', () => {
  const top = plan0.selected[0]?.physicianId ?? '';
  const sb = (log: ActionLog) => foldStandbys(log, et('23:00:00'))[0];

  function preAlerted(): { log: ActionLog; standbyId: string } {
    let log: ActionLog = must(ctx, [], { type: 'proposeStandby', commandId: 'sb-propose', actor: COORD, physicianId: top }, '18:21:00');
    const standbyId = sb(log)?.standbyId ?? '';
    log = must(ctx, log, { type: 'approveStandby', commandId: 'sb-approve', actor: LEAD, standbyId }, '18:22:00');
    return { log, standbyId };
  }

  it('propose -> approve sends a PHI-checked pre-alert (simulated) that expires in 10 min; the physician acknowledges; the plan froze every candidate', () => {
    const { log, standbyId } = preAlerted();
    expect(log.map((e) => e.type)).toEqual(['standby_proposed', 'standby_approved', 'standby_prealert_sent', 'standby_prealert_delivered']);
    const p = log[0]?.type === 'standby_proposed' ? log[0].payload : null;
    expect(p?.candidates.map((c) => c.physicianId)).toEqual(dataset.offShiftRoster.map((r) => r.physicianId));
    expect(p?.message).toMatch(/^Lookahead standby request \(no case information\): possible coverage need \d\d:\d\d–\d\d:\d\d ET at .+\. If needed we would ask you to log on within \d+ min\. Reply: I can be ready \/ Not tonight\.$/);
    expect(findPhiViolations(p?.message ?? '')).toEqual([]);
    const delivered = log[3];
    expect(delivered?.type === 'standby_prealert_delivered' && delivered.payload.expiresAtMs).toBe(et('18:32:00'));
    expect(standbyStatus(sb(log) as never, et('18:25:00'))).toBe('prealert_delivered');
    expect(standbyStatus(sb(log) as never, et('18:32:00'))).toBe('expired');
    // OQ-48: the open standby is the physician's open offer and the pre-alert counts toward 3/week.
    expect(offerLogEntries(log, et('18:25:00'))).toEqual([{ physicianId: top, sentMs: et('18:22:00'), status: 'open' }]);
    expect(run(ctx, log, { type: 'proposeOffer', commandId: 'o-while-sb', actor: COORD, physicianId: top }, '18:25:00')).toMatchObject({ ok: false, code: 'OPEN_OFFER_EXISTS' });
    const ack = must(ctx, log, { type: 'respondStandby', commandId: 'sb-ack', actor: phys(top), standbyId, physicianId: top, response: 'ready' }, '18:25:00');
    expect(standbyStatus(sb(ack) as never, et('18:25:00'))).toBe('acknowledged');
  });

  it('activation: recommended while a covered hospital is deadlocked; propose -> approve -> accept makes it an accepted split shift (scope + seed) that flows into coverage', () => {
    const { log, standbyId } = preAlerted();
    let l = must(ctx, log, { type: 'respondStandby', commandId: 'sb-ack', actor: phys(top), standbyId, physicianId: top, response: 'ready' }, '18:25:00');
    const rec = activationRecommended(ctx, l, standbyId, et('18:26:00'));
    expect(rec?.kind).toBe('deadlock');
    l = must(ctx, l, { type: 'proposeActivation', commandId: 'sb-act', actor: COORD, standbyId }, '18:26:00');
    const act = l.at(-1);
    expect(act?.type).toBe('standby_activation_proposed');
    if (act?.type !== 'standby_activation_proposed') return;
    expect(act.payload.message).toMatch(/^Please log on by \d\d:\d\d ET to cover .+ until \d\d:\d\d ET\.$/);
    expect(act.payload.seededConsultCount).toBeGreaterThan(0); // OQ-35 SEED: median of on-shift peers at the covered hospitals
    expect(act.payload.scopeHospitalIds.length).toBeGreaterThan(0);
    l = must(ctx, l, { type: 'approveActivation', commandId: 'sb-act-approve', actor: LEAD, standbyId }, '18:27:00');
    expect(l.slice(-3).map((e) => e.type)).toEqual(['standby_activation_approved', 'standby_activation_sent', 'standby_activation_delivered']);
    const r = applyCommand(ctx, l, { type: 'respondActivation', commandId: 'sb-act-accept', actor: phys(top), standbyId, physicianId: top, response: 'accept' }, et('18:28:00'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const activated = r.emitted[0];
    expect(activated?.type).toBe('standby_activated');
    const accepted = acceptedOffersOf(r.log, et('18:28:00'));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ physicianId: top, scopeHospitalIds: act.payload.scopeHospitalIds, seededConsultCount: act.payload.seededConsultCount });
    // OQ-39: online no earlier than acceptance + time to come online.
    const minToOnline = dataset.offShiftRoster.find((x) => x.physicianId === top)?.estMinutesToOnline ?? 0;
    expect(accepted[0]?.startMs).toBeGreaterThanOrEqual(et('18:28:00') + minToOnline * 60_000);
    expect(r.coverage?.changes.some((c) => c.outcome !== 'unchanged')).toBe(true);
    // Double accept is refused; the deadlocks at the scope hospitals end when the physician comes online.
    expect(run(ctx, r.log, { type: 'respondActivation', commandId: 'sb-act-accept-2', actor: phys(top), standbyId, physicianId: top, response: 'accept' }, '18:29:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    const after = planWithLog(ctx, r.log, et('18:29:00')).decision;
    for (const n of after.needs.filter((x) => x.kind === 'DEADLOCK_NOW' && act.payload.scopeHospitalIds.includes(x.hospitalId))) expect(n.endMs).toBe(accepted[0]?.startMs);
  });

  it('cancel-on-fill: an open split-shift offer whose needs the activation fills is cancelled', async () => {
    // A second eligible physician (test fixture, see act.helpers twoEligible): PHY-014 holds an open offer; PHY-009 activates and fills its needs.
    const { twoEligible } = await import('./act.helpers');
    const c2 = { dataset: twoEligible };
    const p2 = buildStandbyPlan({ dataset: twoEligible, decision: decide(twoEligible, NOW), model: buildForecastModel(twoEligible, decide(twoEligible, NOW).detection.state, NOW), nowMs: NOW });
    const [a, b] = p2.selected.map((s) => s.physicianId);
    expect(a && b).toBeTruthy();
    if (!a || !b) return;
    let l: ActionLog = must(c2, [], { type: 'proposeStandby', commandId: 'sb-a', actor: COORD, physicianId: a }, '18:21:00');
    const sbId = foldStandbys(l, NOW + 60_000)[0]?.standbyId ?? '';
    l = must(c2, l, { type: 'approveStandby', commandId: 'sb-a-ok', actor: LEAD, standbyId: sbId }, '18:22:00');
    l = must(c2, l, { type: 'respondStandby', commandId: 'sb-a-ack', actor: phys(a), standbyId: sbId, physicianId: a, response: 'ready' }, '18:23:00');
    const deadlockNeed = decide(twoEligible, et('18:24:00')).needs.find((n) => n.kind === 'DEADLOCK_NOW' && (p2.selected[0]?.coveredHospitals ?? []).includes(n.hospitalId));
    expect(deadlockNeed).toBeDefined();
    l = must(c2, l, { type: 'proposeOffer', commandId: 'o-b', actor: COORD, physicianId: b, needIds: deadlockNeed === undefined ? [] : [deadlockNeed.id] }, '18:24:00');
    const offerId = listOffers(l, et('18:24:00'))[0]?.offerId ?? '';
    l = must(c2, l, { type: 'approveOffer', commandId: 'o-b-ok', actor: LEAD, offerId }, '18:25:00');
    l = must(c2, l, { type: 'proposeActivation', commandId: 'sb-a-act', actor: COORD, standbyId: sbId }, '18:26:00');
    l = must(c2, l, { type: 'approveActivation', commandId: 'sb-a-act-ok', actor: LEAD, standbyId: sbId }, '18:27:00');
    const r = applyCommand(c2, l, { type: 'respondActivation', commandId: 'sb-a-go', actor: phys(a), standbyId: sbId, physicianId: a, response: 'accept' }, et('18:28:00'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cancelled = r.emitted.find((e) => e.type === 'offer_cancelled');
    expect(cancelled?.type === 'offer_cancelled' && cancelled.payload).toMatchObject({ offerId, cause: 'gap_filled', filledBy: sbId });
    expect(listOffers(r.log, et('18:28:00'))[0]?.status).toBe('cancelled');
  });

  it('release: the lead stands the physician down with a PHI-checked message; stand-down needs two quiet recomputes (hysteresis)', () => {
    const { log, standbyId } = preAlerted();
    const l = must(ctx, log, { type: 'respondStandby', commandId: 'sb-ack', actor: phys(top), standbyId, physicianId: top, response: 'ready' }, '18:25:00');
    // Risk is high at 18:25 (deadlocks), so no stand-down recommendation.
    expect(standDownRecommended(ctx, l, standbyId, et('18:30:00'))).toMatchObject({ recommended: false, quietNow: false });
    const released = must(ctx, l, { type: 'releaseStandby', commandId: 'sb-release', actor: LEAD, standbyId, reason: 'lead decision' }, '18:31:00');
    const e = released.at(-1);
    expect(e?.type).toBe('standby_released');
    if (e?.type !== 'standby_released') return;
    expect(e.payload.message).toMatch(/^Thank you\. The standby for \d\d:\d\d–\d\d:\d\d ET is released\. No action needed\.$/);
    expect(findPhiViolations(e.payload.message)).toEqual([]);
    expect(standbyStatus(foldStandbys(released, et('18:31:00'))[0] as never, et('18:31:00'))).toBe('released');
  });

  it('every illegal transition is refused with a reason (state machine, 10-min expiry, own standby only, fairness)', () => {
    const { log, standbyId } = preAlerted();
    const at = (c: Command, hms: string) => run(ctx, log, c, hms);
    expect(at({ type: 'approveStandby', commandId: 'x1', actor: LEAD, standbyId }, '18:23:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(at({ type: 'rejectStandby', commandId: 'x2', actor: LEAD, standbyId }, '18:23:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(at({ type: 'proposeActivation', commandId: 'x3', actor: COORD, standbyId }, '18:23:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(at({ type: 'releaseStandby', commandId: 'x4', actor: LEAD, standbyId }, '18:23:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(at({ type: 'respondStandby', commandId: 'x5', actor: phys('PHY-010'), standbyId, physicianId: 'PHY-010', response: 'ready' }, '18:23:00')).toMatchObject({ ok: false, code: 'NOT_OWN_OFFER' });
    expect(at({ type: 'respondStandby', commandId: 'x6', actor: phys(top), standbyId, physicianId: top, response: 'ready' }, '18:32:00')).toMatchObject({ ok: false, code: 'EXPIRED' });
    expect(at({ type: 'respondActivation', commandId: 'x7', actor: phys(top), standbyId, physicianId: top, response: 'accept' }, '18:23:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(at({ type: 'approveStandby', commandId: 'x8', actor: LEAD, standbyId: 'sb-none' }, '18:23:00')).toMatchObject({ ok: false, code: 'UNKNOWN_STANDBY' });
    // tick materializes the pre-alert expiry; afterwards nothing can be done with it.
    const ticked = must(ctx, log, { type: 'tick', commandId: 'tick-1832', actor: { role: 'system', id: 'clock' } }, '18:32:00');
    expect(ticked.at(-1)?.type).toBe('standby_expired');
    expect(run(ctx, ticked, { type: 'cancelStandby', commandId: 'x9', actor: COORD, standbyId, reason: 'late' }, '18:33:00')).toMatchObject({ ok: false, code: 'EXPIRED' });
    // Fairness: the same physician is not pre-alerted twice in one night.
    expect(run(ctx, ticked, { type: 'proposeStandby', commandId: 'sb-again', actor: COORD, physicianId: top }, '18:33:00')).toMatchObject({ ok: false, code: 'NOT_ELIGIBLE' });
    // A physician who fails a brief rule cannot be proposed.
    const ineligible = plan0.candidates.find((c) => !c.eligible)?.physicianId ?? '';
    expect(run(ctx, [], { type: 'proposeStandby', commandId: 'sb-inel', actor: COORD, physicianId: ineligible }, '18:21:00')).toMatchObject({ ok: false, code: 'NOT_ELIGIBLE' });
  });

  it('activation not recommended -> refused unless the coordinator forces it with a reason', async () => {
    // Build a quiet world: no deadlocks (assign the deadlocked consults) and evaluate at a time when the covered cells are calm.
    const { appendEventText } = await import('../src');
    const quiet = appendEventText(
      dataset,
      d0.detection.deadlocks.map((x, i) => `EVT-98${String(i).padStart(3, '0')},2026-03-17T18:20:30-04:00,2026-03-17T18:20:31-04:00,${x.consultId},physician_assigned,PHY-007,${x.hospitalId},Consult assigned`).join('\n'),
      { nowMs: NOW },
    ).dataset;
    const cq = { dataset: quiet };
    const plan = planWithLog(cq, [], et('18:21:00')).plan;
    const cand = plan.candidates.find((c) => c.eligible && c.coveredCells > 0);
    expect(cand).toBeDefined();
    if (!cand) return;
    let l: ActionLog = must(cq, [], { type: 'proposeStandby', commandId: 'q1', actor: COORD, physicianId: cand.physicianId }, '18:21:00');
    const id = foldStandbys(l, et('18:21:00'))[0]?.standbyId ?? '';
    l = must(cq, l, { type: 'approveStandby', commandId: 'q2', actor: LEAD, standbyId: id }, '18:22:00');
    l = must(cq, l, { type: 'respondStandby', commandId: 'q3', actor: phys(cand.physicianId), standbyId: id, physicianId: cand.physicianId, response: 'ready' }, '18:23:00');
    const rec = activationRecommended(cq, l, id, et('18:24:00'));
    if (rec === null) {
      expect(run(cq, l, { type: 'proposeActivation', commandId: 'q4', actor: COORD, standbyId: id }, '18:24:00')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
      const forced = must(cq, l, { type: 'proposeActivation', commandId: 'q5', actor: COORD, standbyId: id, force: true, reason: 'judge request' }, '18:24:00');
      const e = forced.at(-1);
      expect(e?.type === 'standby_activation_proposed' && e.payload.trigger.kind).toBe('coordinator_override');
    } else {
      // The quiet world still has a hard gap at 20:00+ within reach: the recommendation names it.
      expect(rec.kind).toBe('pgap');
    }
  });
});

describe('messages, determinism', () => {
  it('all three messages pass the PHI guard and name hospitals, hours and start time only', () => {
    const names = dataset.hospitals.slice(0, 2).map((h) => h.hospitalName);
    for (const t of [
      preAlertMessage({ hospitalNames: names, startMs: et('18:40:00'), endMs: et('21:20:00'), minutesToOnline: 15 }),
      activationMessage({ hospitalNames: names, logOnByMs: et('19:00:00'), endMs: et('21:20:00') }),
      releaseMessage({ startMs: et('18:40:00'), endMs: et('21:20:00') }),
    ]) {
      expect(findPhiViolations(t)).toEqual([]);
      expect(t).not.toMatch(/CON-|EVT-|PHY-/);
    }
    expect(() => preAlertMessage({ hospitalNames: ['Stroke Center'], startMs: 0, endMs: 1, minutesToOnline: 5 })).toThrow(/PHI guard/);
  });

  it('the plan is byte-identical across runs and seeded shuffles of the event order', () => {
    const a = JSON.stringify(plan0);
    expect(JSON.stringify(buildStandbyPlan({ dataset, decision: d0, model: model0, nowMs: NOW }))).toBe(a);
    for (const seed of [1, 2]) {
      const ds = { ...dataset, events: seededShuffle(dataset.events, seed) };
      const d = decide(ds, NOW);
      expect(JSON.stringify(buildStandbyPlan({ dataset: ds, decision: d, model: buildForecastModel(ds, d.detection.state, NOW), nowMs: NOW }))).toBe(a);
    }
  });
});
