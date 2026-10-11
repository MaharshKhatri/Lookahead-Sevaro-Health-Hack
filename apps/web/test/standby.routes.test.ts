import { DATA_DIR, body, params, req } from './helpers';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { STANDBY_ACTIVATE_PGAP, findPhiViolations, planWithLog, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import * as clockRoute from '@/app/api/clock/route';
import * as commandsRoute from '@/app/api/commands/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as forecastRoute from '@/app/api/forecast/route';
import * as qualityRoute from '@/app/api/quality/route';
import * as rewindRoute from '@/app/api/rewind/route';
import * as standbyRoute from '@/app/api/standby/route';
import * as standbyPhoneRoute from '@/app/api/standby/[id]/route';
import * as viewRoute from '@/app/api/view/route';
import type { CommandResponse, PublicStandbyDTO, RewindReportDTO, ViewDTO } from '@/lib/dto';
import { LEAD_COOKIE, leadCookieValue, standbyToken } from '@/server/auth';
import type { BacktestReport } from '@/server/quality';
import { disposeStore } from '@/server/store';

/**
 * Phase 7 route tests: the standby network through POST /api/commands (D-90
 * lifecycle: pre-alert -> approve -> "I can be ready" -> activation -> approve
 * -> accept), the PHI-safe phone view, link tokens (OQ-44), the forecast /
 * standby / policy fields of /api/view, /api/quality and the view timing.
 * Expected answers come from the engine run on the same data package.
 */

const dataset = loadDataset(DATA_DIR);
const NOW = snapshotAsOfMs(dataset) ?? 0;
const enginePlan = planWithLog({ dataset }, [], NOW).plan;

const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));
const leadCookie = () => `${LEAD_COOKIE}=${encodeURIComponent(leadCookieValue())}`;
/** The lead carries the PIN cookie; a physician's answer carries the standby link token (OQ-44). */
const command = (role: string, cmd: Record<string, unknown>, extra: Record<string, unknown> = {}, actorId?: string) =>
  commandsRoute.POST(
    req('/api/commands', {
      method: 'POST',
      role,
      ...(actorId === undefined ? {} : { actorId }),
      ...(role === 'clinical_lead' ? { cookie: leadCookie() } : {}),
      body: JSON.stringify({ command: cmd, ...(role === 'physician' && typeof cmd.standbyId === 'string' && !('token' in extra) ? { token: standbyToken(cmd.standbyId) } : {}), ...extra }),
    }),
  );
const clock = (b: Record<string, unknown>) => clockRoute.POST(req('/api/clock', { method: 'POST', body: JSON.stringify(b) }));
const phone = async (standbyId: string, t = standbyToken(standbyId)) => standbyPhoneRoute.GET(req(`/api/standby/${standbyId}?t=${t}`), params({ id: standbyId }));
const PHI = /\bCON-\d+|\bEVT-\d+|\bstroke\b|\bpatient|\bimaging/i;

async function proposeStandby(): Promise<{ standbyId: string; physicianId: string }> {
  const v = await view();
  const physicianId = v.standby.plan.selected[0]?.physicianId;
  expect(physicianId).toBe(enginePlan.selected[0]?.physicianId);
  const r = await command('coordinator', { type: 'proposeStandby', physicianId });
  expect(r.status).toBe(200);
  const b = await body<CommandResponse & { emitted: { standbyId?: string }[] }>(r);
  const standbyId = b.emitted[0]?.standbyId ?? '';
  expect(standbyId).toMatch(/^sb-/);
  return { standbyId, physicianId: physicianId ?? '' };
}

beforeEach(async () => {
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});

afterAll(() => disposeStore());

describe('GET /api/view carries the forecast, the standby plan and the policy catalog (Phase 7)', () => {
  it('forecast: one row per hospital, risk-ranked, the surging hospital spiking now; /api/forecast is the same object', async () => {
    const v = await view();
    const f = v.forecast;
    expect(f.asOfMs).toBe(NOW);
    expect(f.hospitals).toHaveLength(dataset.hospitals.length);
    expect([...f.hospitals].map((h) => h.riskRank).sort((a, b) => a - b)).toEqual(dataset.hospitals.map((_, i) => i + 1));
    const surge = v.demand[0];
    expect(surge).toBeDefined();
    const row = f.hospitals.find((h) => h.hospitalId === surge?.hospitalId);
    expect(row?.spikeNow).toBe(true);
    expect(row?.checkpoints[0]?.pSpike).toBe(1);
    expect(row?.observedLast60).toBe(surge?.count);
    // Past bars: 12 x 15-min buckets ending at now; the last four add up to the trailing-60 count.
    expect(row?.past).toHaveLength(12);
    expect(row?.past.slice(-4).reduce((s, b) => s + b.count, 0)).toBe(row?.observedLast60);
    const direct = await body<ViewDTO['forecast']>(await forecastRoute.GET());
    expect(direct).toEqual(f);
  });

  it('standby plan equals the engine plan at 18:20 (selected physicians, EUM totals, empty bench); /api/standby is the same object', async () => {
    const v = await view();
    const p = v.standby.plan;
    expect(p.selected.map((s) => s.physicianId)).toEqual(enginePlan.selected.map((s) => s.physicianId));
    expect(p.totals.totalWeightedEUM).toBe(enginePlan.totalWeightedEUM);
    expect(p.totals.expectedEUMAvoided).toBe(enginePlan.expectedEUMAvoided);
    expect(p.emptyBenchHospitals.map((h) => h.hospitalId)).toEqual(enginePlan.emptyBenchHospitals.map((h) => h.hospitalId));
    expect(p.candidates).toHaveLength(dataset.offShiftRoster.length);
    expect(p.hospitals.every((h) => h.cells.length === p.cellStarts.length)).toBe(true);
    expect(v.standby.standbys).toEqual([]);
    // Grid cells carry P(gap) where a standby cell aligns (quarter hours), null on the first partial bucket.
    const first = v.coverage.rows[0];
    expect(first?.cells[0]?.pGap).toBeNull();
    const aligned = first?.cells.find((c) => p.cellStarts.includes(c.startMs));
    expect(typeof aligned?.pGap).toBe('number');
    const direct = await body<ViewDTO['standby']>(await standbyRoute.GET());
    expect(direct).toEqual(v.standby);
  });

  it('policy catalog lists every FORECAST_/HAWKES_/STROKE_SHARE_/STANDBY_ constant with the engine value and a BRIEF / LOOKAHEAD-DEFINED label', async () => {
    const v = await view();
    const names = v.policy.map((p) => p.name);
    for (const n of ['FORECAST_DAY_RATE_PRIOR_A', 'HAWKES_ETA_GRID', 'STROKE_SHARE_PRIOR_WEIGHT', 'STANDBY_ACTIVATE_PGAP', 'STANDBY_MIN_WINDOW_MIN', 'OFFER_EXPIRY_MINUTES']) expect(names).toContain(n);
    expect(v.policy.find((p) => p.name === 'STANDBY_ACTIVATE_PGAP')?.value).toBe(String(STANDBY_ACTIVATE_PGAP));
    expect(v.policy.find((p) => p.name === 'STANDBY_MIN_WINDOW_MIN')?.source).toMatch(/^BRIEF/);
    expect(v.policy.find((p) => p.name === 'STANDBY_ACTIVATE_PGAP')?.source).toMatch(/LOOKAHEAD-DEFINED/);
    expect(v.policy.every((p) => p.source.startsWith('BRIEF') || p.source.includes('LOOKAHEAD-DEFINED') || p.source.startsWith('OQ'))).toBe(true);
  });

  it('stays fast: a recomputed view with a warm forecast fit takes well under the 150 ms budget (x3 for parallel vitest workers)', async () => {
    await view();
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      // A clock "set" to the same instant bumps the version, so the view recomputes with the fit memoized for this minute.
      await clock({ action: 'set', nowMs: NOW });
      const t0 = performance.now();
      await view();
      times.push(performance.now() - t0);
    }
    const median = [...times].sort((a, b) => a - b)[2] ?? 0;
    console.log(`/api/view recompute (warm fit): ${times.map((t) => t.toFixed(0)).join(', ')} ms; median ${median.toFixed(0)} ms`);
    // 150 ms isolated budget x PARALLEL_FACTOR 3 (packages/engine/test/bench.helpers.ts): other test files share the CPU.
    expect(median).toBeLessThan(450);
  });
});

describe('standby lifecycle through POST /api/commands (D-90 4.4, brief "Users and Decision Rights", 10-minute expiry, PHI)', () => {
  it('propose -> lead approves (PIN) -> phone "I can be ready" (token) -> activation recommended -> propose -> approve -> phone accepts -> ACTIVATED, coverage changes', async () => {
    const deadlockBefore = (await view()).coverage.rows.flatMap((r) => r.cells).filter((c) => c.class === 'DEADLOCK').length;
    expect(deadlockBefore).toBeGreaterThan(0);
    const { standbyId, physicianId } = await proposeStandby();
    let v = await view();
    let sb = v.standby.standbys[0];
    expect(sb).toMatchObject({ standbyId, physicianId, status: 'proposed' });
    expect(sb?.allowedActions.clinical_lead).toContain('approveStandby');
    expect(sb?.candidates).toHaveLength(dataset.offShiftRoster.length);
    expect(sb?.standbyPath).toBe(`/standby/${standbyId}?t=${standbyToken(standbyId)}`);
    // The coordinator cannot approve; the lead needs the PIN cookie.
    expect((await command('coordinator', { type: 'approveStandby', standbyId })).status).toBe(403);
    const noPin = await commandsRoute.POST(req('/api/commands', { method: 'POST', role: 'clinical_lead', body: JSON.stringify({ command: { type: 'approveStandby', standbyId } }) }));
    expect(noPin.status).toBe(401);
    expect((await command('clinical_lead', { type: 'approveStandby', standbyId })).status).toBe(200);
    v = await view();
    sb = v.standby.standbys[0];
    expect(sb?.status).toBe('prealert_delivered');
    expect(sb?.msUntilExpiry).toBe(10 * 60_000);
    expect(sb?.allowedActions.physician).toEqual(['respondStandby']);

    // Phone: only the delivered pre-alert; no case information.
    let ph = await body<PublicStandbyDTO>(await phone(standbyId));
    expect(ph.status).toBe('prealert_delivered');
    expect(ph.respond).toBe('standby');
    expect(ph.canRespond).toBe(true);
    expect(ph.prealertLines?.join('\n')).toMatch(/^Lookahead standby request \(no case information\)/);
    expect(ph.prealertLines?.join('\n')).not.toMatch(PHI);
    expect(ph.activationLines).toBeNull();
    expect(findPhiViolations(JSON.stringify(ph).replace(/"[a-zA-Z]+":/g, ''), { allowedPhrases: ph.hospitals })).toEqual([]);
    expect(ph.hospitals.length).toBeGreaterThan(0);

    expect((await command('physician', { type: 'respondStandby', standbyId, response: 'ready' }, {}, physicianId)).status).toBe(200);
    v = await view();
    sb = v.standby.standbys[0];
    expect(sb?.status).toBe('acknowledged');
    // At 18:20 a covered hospital is deadlocked, so the engine recommends activation (deadlock trigger).
    expect(sb?.activationRecommended?.kind).toBe('deadlock');
    expect(sb?.allowedActions.coordinator).toContain('proposeActivation');
    expect(sb?.standDownRecommended).toBe(false);
    expect((await command('coordinator', { type: 'proposeActivation', standbyId })).status).toBe(200);
    v = await view();
    sb = v.standby.standbys[0];
    expect(sb?.status).toBe('activation_proposed');
    expect(sb?.activation?.trigger.kind).toBe('deadlock');
    expect(sb?.activation?.seededConsultCount).toBeGreaterThan(0);
    expect(sb?.allowedActions.clinical_lead).toContain('approveActivation');
    expect((await command('clinical_lead', { type: 'approveActivation', standbyId })).status).toBe(200);
    v = await view();
    sb = v.standby.standbys[0];
    expect(sb?.status).toBe('activation_delivered');
    expect(sb?.activation?.msUntilExpiry).toBe(10 * 60_000);

    ph = await body<PublicStandbyDTO>(await phone(standbyId));
    expect(ph.respond).toBe('activation');
    expect(ph.activationLines?.join('\n')).toMatch(/^Please log on by \d\d:\d\d ET to cover .+ until \d\d:\d\d ET\.$/);
    expect(ph.activationLines?.join('\n')).not.toMatch(PHI);
    const accept = await command('physician', { type: 'respondActivation', standbyId, response: 'accept' }, {}, physicianId);
    expect(accept.status).toBe(200);
    expect((await body<CommandResponse>(accept)).coverage?.changes.some((c) => c.outcome !== 'unchanged')).toBe(true);
    v = await view();
    sb = v.standby.standbys[0];
    expect(sb?.status).toBe('activated');
    expect(sb?.outcome?.status).toBe('activated');
    expect(sb?.activation?.effectiveStartMs).not.toBeNull();
    // The activated standby is staffing: the scope hospitals' deadlocks end when the physician comes online, so fewer DEADLOCK cells remain.
    const deadlockAfter = v.coverage.rows.flatMap((r) => r.cells).filter((c) => c.class === 'DEADLOCK').length;
    expect(deadlockAfter).toBeLessThan(deadlockBefore);
    expect(v.coverage.markers.some((m) => m.starts.some((s) => s.physicianId === physicianId && s.source === 'split_shift_offer'))).toBe(true);
    ph = await body<PublicStandbyDTO>(await phone(standbyId));
    expect(ph.status).toBe('activated');
    expect(ph.canRespond).toBe(false);
    expect(ph.headline).toBe('Activated. Thank you.');
    // Double accept is refused.
    expect((await command('physician', { type: 'respondActivation', standbyId, response: 'accept' }, {}, physicianId)).status).toBe(409);
  });

  it('release path: pre-alert -> ready -> the lead releases (allowed any time while acknowledged) -> RELEASED with a PHI-checked message', async () => {
    const { standbyId, physicianId } = await proposeStandby();
    await command('clinical_lead', { type: 'approveStandby', standbyId });
    await command('physician', { type: 'respondStandby', standbyId, response: 'ready' }, {}, physicianId);
    let sb = (await view()).standby.standbys[0];
    expect(sb?.allowedActions.clinical_lead).toContain('releaseStandby');
    expect((await command('coordinator', { type: 'releaseStandby', standbyId })).status).toBe(403);
    expect((await command('clinical_lead', { type: 'releaseStandby', standbyId, reason: 'lead decision' })).status).toBe(200);
    sb = (await view()).standby.standbys[0];
    expect(sb?.status).toBe('released');
    expect(sb?.outcome?.detail).toMatch(/Thank you\. The standby for \d\d:\d\d–\d\d:\d\d ET is released\./);
    const ph = await body<PublicStandbyDTO>(await phone(standbyId));
    expect(ph.status).toBe('released');
    expect(ph.releaseLines?.join('\n')).not.toMatch(PHI);
    expect(ph.canRespond).toBe(false);
  });

  it('"Not tonight" declines; a rejected proposal never sends; the pre-alert expires after 10 minutes (tick)', async () => {
    const { standbyId, physicianId } = await proposeStandby();
    await command('clinical_lead', { type: 'approveStandby', standbyId });
    expect((await command('physician', { type: 'respondStandby', standbyId, response: 'not_tonight' }, {}, physicianId)).status).toBe(200);
    expect((await view()).standby.standbys[0]?.status).toBe('declined');
    await resetRoute.POST();
    const second = await proposeStandby();
    expect((await command('clinical_lead', { type: 'rejectStandby', standbyId: second.standbyId, reason: 'phone tree tonight' })).status).toBe(200);
    expect((await view()).standby.standbys[0]).toMatchObject({ status: 'rejected', outcome: { status: 'rejected', detail: 'phone tree tonight' } });
    await resetRoute.POST();
    const third = await proposeStandby();
    await command('clinical_lead', { type: 'approveStandby', standbyId: third.standbyId });
    await clock({ action: 'advance', minutes: 11 });
    const v = await view();
    expect(v.standby.standbys[0]?.status).toBe('expired');
    expect((await body<PublicStandbyDTO>(await phone(third.standbyId))).canRespond).toBe(false);
    const late = await command('physician', { type: 'respondStandby', standbyId: third.standbyId, response: 'ready' }, {}, third.physicianId);
    expect(late.status).toBe(410);
  });

  it('OQ-44: respondStandby / respondActivation without the standby token are 403 BAD_TOKEN; the phone view needs the token; unknown standby is 404', async () => {
    const { standbyId, physicianId } = await proposeStandby();
    await command('clinical_lead', { type: 'approveStandby', standbyId });
    const noToken = await command('physician', { type: 'respondStandby', standbyId, response: 'ready' }, { token: 'forged' }, physicianId);
    expect(noToken.status).toBe(403);
    expect((await body(noToken)).code).toBe('BAD_TOKEN');
    const noTokenAct = await command('physician', { type: 'respondActivation', standbyId, response: 'accept' }, { token: '' }, physicianId);
    expect(noTokenAct.status).toBe(403);
    expect((await view()).standby.standbys[0]?.status).toBe('prealert_delivered');
    const bad = await phone(standbyId, 'forged');
    expect(bad.status).toBe(403);
    expect((await body(bad)).code).toBe('BAD_TOKEN');
    const unknown = await phone('sb-nope');
    expect(unknown.status).toBe(404);
    // Another physician cannot answer this standby.
    const other = dataset.offShiftRoster.find((r) => r.physicianId !== physicianId)?.physicianId ?? '';
    const notOwn = await command('physician', { type: 'respondStandby', standbyId, response: 'ready' }, {}, other);
    expect(notOwn.status).toBe(403);
    expect((await body(notOwn)).code).toBe('NOT_OWN_OFFER');
  });

  it('fairness and caps: a second pre-alert for the same physician tonight is refused; an open standby blocks a split-shift offer to them (OQ-48)', async () => {
    const { standbyId, physicianId } = await proposeStandby();
    await command('clinical_lead', { type: 'approveStandby', standbyId });
    const offer = await command('coordinator', { type: 'proposeOffer', physicianId });
    expect(offer.status).toBe(409);
    expect((await body(offer)).code).toBe('OPEN_OFFER_EXISTS');
    const again = await command('coordinator', { type: 'proposeStandby', physicianId });
    expect([409, 422]).toContain(again.status);
  });
});

describe('GET /api/quality and GET /api/rewind', () => {
  it('quality: the backtest JSON with three model rows, reliability bins and first-warning lead times', async () => {
    const r = await qualityRoute.GET();
    expect(r.status).toBe(200);
    const q = await body<BacktestReport>(r);
    expect(Object.keys(q.metrics).sort()).toEqual(['M0', 'M1', 'M2']);
    for (const m of Object.values(q.metrics)) expect(m.n).toBe(q.design.pairCount);
    expect(Object.keys(q.reliability).sort()).toEqual(['M0', 'M1', 'M2']);
    expect(q.reliability.M2).toHaveLength(q.design.reliabilityBins);
    expect(q.firstWarning.onsets.length).toBe(q.firstWarning.n);
    expect(q.leakage.allIdentical).toBe(true);
  });

  it('rewind: a report with origins, three lines and markers, or an honest 503 NOT_READY', async () => {
    const r = await rewindRoute.GET();
    if (r.status === 503) {
      expect((await body(r)).code).toBe('NOT_READY');
      return;
    }
    expect(r.status).toBe(200);
    const rw = await body<RewindReportDTO>(r);
    expect(rw.origins.length).toBeGreaterThan(0);
    expect(rw.lines.map((l) => l.kind)).toEqual(['actual', 'reactive', 'anticipatory']);
    expect(rw.toMs).toBe(NOW);
    expect(rw.hospitalNames).toBeDefined();
  });
});
