import { LIVE_DIR, DATA_DIR, body, lastStreamRow, params, req } from './helpers';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decide, snapshotAsOfMs } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import * as auditCsvRoute from '@/app/api/audit.csv/route';
import * as auditRoute from '@/app/api/audit/[offerId]/route';
import * as clockRoute from '@/app/api/clock/route';
import * as commandsRoute from '@/app/api/commands/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as eventsRoute from '@/app/api/events/route';
import * as integrityRoute from '@/app/api/integrity/route';
import * as offerRoute from '@/app/api/offers/[id]/route';
import * as streamRoute from '@/app/api/stream/route';
import * as viewRoute from '@/app/api/view/route';
import type { CommandResponse, PublicOfferDTO, ViewDTO } from '@/lib/dto';
import { LEAD_COOKIE, leadCookieValue, offerToken } from '@/server/auth';
import { disposeStore, getReadyStore } from '@/server/store';
import { memoSize } from '@/server/view';

/**
 * Route tests (Session 6 gate). Expected answers come from the engine run on
 * the same data package, never from literals in app code.
 */

const engineAt1820 = (() => {
  const ds = loadDataset(DATA_DIR);
  const now = snapshotAsOfMs(ds) ?? 0;
  return decide(ds, now);
})();

const liveKeyDir = async () => join(LIVE_DIR, (await getReadyStore()).snapshot().datasetMeta.key);
const view = async () => body<ViewDTO>(await viewRoute.GET(req('/api/view')));
const leadCookie = () => `${LEAD_COOKIE}=${encodeURIComponent(leadCookieValue())}`;
/** The clinical lead carries the PIN cookie; a physician's answer carries the offer link token (OQ-44). */
const command = (role: string, cmd: Record<string, unknown>, extra: Record<string, unknown> = {}, actorId?: string) =>
  commandsRoute.POST(
    req('/api/commands', {
      method: 'POST',
      role,
      ...(actorId === undefined ? {} : { actorId }),
      ...(role === 'clinical_lead' ? { cookie: leadCookie() } : {}),
      body: JSON.stringify({ command: cmd, ...(role === 'physician' && typeof cmd.offerId === 'string' ? { token: offerToken(cmd.offerId) } : {}), ...extra }),
    }),
  );
const clock = (b: Record<string, unknown>) => clockRoute.POST(req('/api/clock', { method: 'POST', body: JSON.stringify(b) }));

async function proposeTop(commandId = 'cmd-propose'): Promise<string> {
  const v = await view();
  const physicianId = v.recommendedOffer?.physicianId;
  expect(physicianId).toBeDefined();
  const r = await command('coordinator', { type: 'proposeOffer', physicianId, commandId });
  expect(r.status).toBe(200);
  const b = await body<CommandResponse & { emitted: { offerId?: string }[] }>(r);
  const offerId = b.emitted[0]?.offerId;
  expect(offerId).toBeDefined();
  return offerId ?? '';
}

beforeEach(async () => {
  disposeStore();
  const r = await resetRoute.POST();
  expect(r.status).toBe(200);
});

afterAll(() => disposeStore());

describe('GET /api/view at the reference instant (brief "What Teams Must Demonstrate" #3, #5)', () => {
  it('top attention item and recommended physician equal the engine output at 18:20', async () => {
    const v = await view();
    expect(v.clock.nowMs).toBe(engineAt1820.nowMs);
    expect(v.clock.mode).toBe('paused');
    expect(v.attention[0]?.id).toBe(engineAt1820.detection.attention[0]?.id);
    expect(v.attention[0]?.consultIds).toEqual(engineAt1820.detection.attention[0]?.consultIds);
    expect(v.attention[0]?.why.length).toBeGreaterThan(0);
    expect(v.attention[0]?.because.length).toBeGreaterThan(0);
    expect(v.attention[0]?.scoreBreakdown.reduce((a, f) => a + f.points, 0)).toBeCloseTo(v.attention[0]?.score ?? 0, 5);
    expect(v.recommendedOffer?.physicianId).toBe(engineAt1820.recommendedOffer?.physicianId);
    expect(v.recommendation?.attentionItemId).toBe(engineAt1820.recommendation?.attentionItemId);
    expect(v.ledger.map((r) => r.physicianId)).toEqual(engineAt1820.ledger.map((r) => r.physicianId));
    expect(v.ledger.filter((r) => r.eligible).map((r) => r.physicianId)).toEqual([engineAt1820.recommendedOffer?.physicianId]);
  });

  it('integrity summary: 8/8 and 18/18 with 0 diffs; naive arrival order differs', async () => {
    const v = await view();
    expect(v.integrity.physicians).toBe('8/8 rows match');
    expect(v.integrity.consults).toBe('18/18 rows match');
    expect(v.integrity.diffs).toBe(0);
    expect(v.integrity.naive.diffs).toBeGreaterThan(0);
  });

  it('coverage grid: 15-min buckets from now over the decision horizon, quarter-hour aligned; classes from the engine', async () => {
    const v = await view();
    const g = v.coverage;
    expect(g.buckets[0]?.startMs).toBe(v.clock.nowMs);
    for (const b of g.buckets.slice(1)) expect(b.startMs % (15 * 60_000)).toBe(0);
    expect(g.buckets.at(-1)?.endMs).toBe(engineAt1820.decisionCoverage.horizonEndMs);
    expect(g.rows).toHaveLength(engineAt1820.detection.staffing.hospitals.length);
    // Every DEADLOCK_NOW need's hospital shows DEADLOCK in the first bucket.
    for (const n of engineAt1820.needs.filter((x) => x.kind === 'DEADLOCK_NOW')) {
      expect(g.rows.find((r) => r.hospitalId === n.hospitalId)?.cells[0]?.class).toBe('DEADLOCK');
    }
    // Every HARD_GAP need start lies in a HARD_GAP (or DEADLOCK) bucket.
    for (const n of engineAt1820.needs.filter((x) => x.kind === 'HARD_GAP')) {
      const cell = g.rows.find((r) => r.hospitalId === n.hospitalId)?.cells.find((c) => c.startMs <= n.startMs && n.startMs < c.endMs);
      expect(['HARD_GAP', 'DEADLOCK']).toContain(cell?.class);
    }
    expect(g.markers.length).toBeGreaterThan(0);
  });

  it('is memoized per (version, now): repeated reads do not recompute', async () => {
    await view();
    const n = memoSize();
    await view();
    await view();
    expect(memoSize()).toBe(n);
  });
});

describe('demo safety (Session 7)', () => {
  it('OQ-46: the quiet-feed banner appears only when the clock is more than 2 min past the last ingested event', async () => {
    const v = await view();
    expect(v.lastEventAtMs).not.toBeNull();
    expect(v.clock.nowMs - (v.lastEventAtMs ?? 0)).toBeLessThan(120_000);
    expect(v.noNewEventsSince).toBeUndefined();
    await clock({ action: 'advance', minutes: 3 });
    expect((await view()).noNewEventsSince).toBe(v.lastEventAtMs);
  });

  it('OQ-43: after a decline the engine offers nobody else for the same need, and the view suggests escalation', async () => {
    const offerId = await proposeTop();
    await command('clinical_lead', { type: 'approveOffer', offerId });
    const physicianId = engineAt1820.recommendedOffer?.physicianId ?? '';
    expect((await command('physician', { type: 'respond', offerId, response: 'decline' }, {}, physicianId)).status).toBe(200);
    const v = await view();
    expect(v.offers[0]?.status).toBe('declined');
    expect(v.nextOffer).toMatchObject({ physicianId: null, escalationSuggested: true });
    expect(v.nextOffer.why.join(' ')).toContain('no further eligible physician');
  });
});

describe('POST /api/events (live append, brief #8)', () => {
  it('accepts a new row, reports a duplicate and rejects a bad row, with line numbers', async () => {
    const v = await view();
    const [e1] = v.sample.nextEventIds;
    const nowIso = '2026-03-17T18:20:00-04:00';
    const good = `${e1},${nowIso},,${v.sample.nextConsultId},consult_received,,${v.sample.surgingHospitalId},Stroke consult request received`;
    const dup = lastStreamRow();
    const badRow = `${e1}9,${nowIso},,${v.sample.nextConsultId},not_an_event_type,,${v.sample.surgingHospitalId},x`;
    const r = await eventsRoute.POST(req('/api/events', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: [good, dup, badRow].join('\n') }));
    expect(r.status).toBe(200);
    const b = await body<{ accepted: { line: number; eventId: string; ingestedAtDefaulted: boolean }[]; duplicates: { line: number }[]; rejected: { line: number; reason: string }[] }>(r);
    expect(b.accepted).toEqual([expect.objectContaining({ line: 1, eventId: e1, ingestedAtDefaulted: true })]);
    expect(b.duplicates.map((d) => d.line)).toEqual([2]);
    expect(b.rejected.map((d) => d.line)).toEqual([3]);
    const after = await view();
    expect(after.integrity.appendedCount).toBe(1);
    expect(after.consults.some((c) => c.consultId === v.sample.nextConsultId)).toBe(true);
    // Persisted to data/live/<datasetKey>/events.jsonl (FileRepo).
    expect(readFileSync(join(await liveKeyDir(), 'events.jsonl'), 'utf8')).toContain(e1);
  });

  it('accepts JSON {text} and rejects an empty body with 400', async () => {
    const r = await eventsRoute.POST(req('/api/events', { method: 'POST', body: JSON.stringify({ text: '' }) }));
    expect(r.status).toBe(400);
    expect((await body(r)).code).toBe('BAD_REQUEST');
  });
});

describe('POST /api/commands (brief "Users and Decision Rights")', () => {
  it('role errors are 403 with the engine code', async () => {
    const offerId = await proposeTop();
    const asCoordinator = await command('coordinator', { type: 'approveOffer', offerId });
    expect(asCoordinator.status).toBe(403);
    expect((await body(asCoordinator)).code).toBe('FORBIDDEN_ROLE');
    const asLeadPropose = await command('clinical_lead', { type: 'proposeOffer', physicianId: 'x' });
    expect(asLeadPropose.status).toBe(403);
    const system = await commandsRoute.POST(req('/api/commands', { method: 'POST', role: 'system', body: JSON.stringify({ command: { type: 'tick' } }) }));
    expect(system.status).toBe(403);
    expect((await body(system)).code).toBe('FORBIDDEN_ROLE');
  });

  it('a physician cannot answer someone else\'s offer (NOT_OWN_OFFER, 403)', async () => {
    const offerId = await proposeTop();
    expect((await command('clinical_lead', { type: 'approveOffer', offerId })).status).toBe(200);
    const other = engineAt1820.ledger.find((e) => !e.eligible)?.physicianId ?? 'nobody';
    const r = await command('physician', { type: 'respond', offerId, response: 'accept' }, {}, other);
    expect(r.status).toBe(403);
    expect((await body(r)).code).toBe('NOT_OWN_OFFER');
  });

  it('is idempotent by commandId: a retry returns the original events and appends nothing', async () => {
    const first = await body<CommandResponse>(await command('coordinator', { type: 'proposeOffer', physicianId: engineAt1820.recommendedOffer?.physicianId, commandId: 'same-id' }));
    const again = await body<CommandResponse>(await command('coordinator', { type: 'proposeOffer', physicianId: engineAt1820.recommendedOffer?.physicianId, commandId: 'same-id' }));
    expect(first.ok).toBe(true);
    expect(again.replayed).toBe(true);
    expect(again.emitted?.map((e) => e.actionId)).toEqual(first.emitted?.map((e) => e.actionId));
    expect(again.seq).toBe(first.seq);
    expect((await view()).offers).toHaveLength(1);
  });

  it('stale expectedSeq is a 409 CONFLICT', async () => {
    const offerId = await proposeTop();
    const r = await command('clinical_lead', { type: 'approveOffer', offerId }, { expectedSeq: 0 });
    expect(r.status).toBe(409);
    expect((await body(r)).code).toBe('CONFLICT');
    const ok = await command('clinical_lead', { type: 'approveOffer', offerId }, { expectedSeq: (await view()).logSeq });
    expect(ok.status).toBe(200);
  });

  it('concurrent commands with the same expectedSeq: the mutex serializes them, exactly one wins, the other is 409', async () => {
    const seq = (await view()).logSeq;
    const physicianId = engineAt1820.recommendedOffer?.physicianId;
    const [a, b] = await Promise.all([
      command('coordinator', { type: 'proposeOffer', physicianId, commandId: 'race-a' }, { expectedSeq: seq }),
      command('coordinator', { type: 'proposeOffer', physicianId, commandId: 'race-b' }, { expectedSeq: seq }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await view()).offers).toHaveLength(1);
  });

  it('malformed commands are 400, never a crash', async () => {
    expect((await command('coordinator', { type: 'raiseEscalation' })).status).toBe(400);
    expect((await command('coordinator', { type: 'nope' })).status).toBe(400);
    const noRole = await commandsRoute.POST(req('/api/commands', { method: 'POST', body: '{"command":{"type":"tick"}}' }));
    expect(noRole.status).toBe(400);
    const junk = await commandsRoute.POST(req('/api/commands', { method: 'POST', role: 'coordinator', body: '{not json' }));
    expect(junk.status).toBe(400);
  });
});

describe('closed loop through the routes (brief #6) and the phone view', () => {
  it('propose -> approve -> phone sees only the message -> accept -> offer accepted, coverage effect frozen, audit lists 6', async () => {
    const offerId = await proposeTop();
    let phone = await body<PublicOfferDTO>(await offerRoute.GET(req(`/api/offers/${offerId}?t=${offerToken(offerId)}`), params({ id: offerId })));
    expect(phone.status).toBe('proposed');
    expect(phone.messageLines).toBeNull();
    expect((await command('clinical_lead', { type: 'approveOffer', offerId })).status).toBe(200);
    phone = await body<PublicOfferDTO>(await offerRoute.GET(req(`/api/offers/${offerId}?t=${offerToken(offerId)}`), params({ id: offerId })));
    expect(phone.status).toBe('delivered');
    expect(phone.canRespond).toBe(true);
    expect(phone.messageLines?.join('\n')).not.toMatch(/\bCON-\d+|\bstroke\b|\bpatient/i);
    expect(phone.msUntilExpiry).toBe(10 * 60_000);
    // QR for delivered offers, rendered server-side, on the request's host.
    const v = await view();
    expect(v.qr?.[offerId]?.url).toBe(`http://localhost:3000/offer/${offerId}?t=${offerToken(offerId)}`);
    expect(v.qr?.[offerId]?.svg).toContain('<svg');
    const accept = await command('physician', { type: 'respond', offerId, response: 'accept' }, {}, phone.physicianId);
    expect(accept.status).toBe(200);
    const after = await view();
    expect(after.offers[0]?.status).toBe('accepted');
    expect(after.offerContext.source).toBe('accepted');
    expect(after.offerContext.whatIf.rows.length).toBeGreaterThan(0);
    expect(after.offerContext.whatIf.filledNeedIds.length).toBeGreaterThan(0);
    const audit = await body<{ considered: unknown[]; outcome: { status: string } }>(await auditRoute.GET(req(`/api/audit/${offerId}`), params({ offerId })));
    expect(audit.considered).toHaveLength(engineAt1820.ledger.length);
    expect(audit.outcome.status).toBe('accepted');
    const csv = await (await auditCsvRoute.GET()).text();
    expect(csv.split('\n')[1]).toContain(offerId);
  });

  it('OQ-44: the phone view and the answer need the offer link token; lead commands need the PIN cookie', async () => {
    const offerId = await proposeTop();
    const noToken = await offerRoute.GET(req(`/api/offers/${offerId}`), params({ id: offerId }));
    expect(noToken.status).toBe(403);
    expect((await body(noToken)).code).toBe('BAD_TOKEN');
    const noPin = await commandsRoute.POST(req('/api/commands', { method: 'POST', role: 'clinical_lead', body: JSON.stringify({ command: { type: 'approveOffer', offerId } }) }));
    expect(noPin.status).toBe(401);
    expect((await body(noPin)).code).toBe('PIN_REQUIRED');
    expect((await command('clinical_lead', { type: 'approveOffer', offerId })).status).toBe(200);
    const physicianId = engineAt1820.recommendedOffer?.physicianId ?? '';
    const forged = await command('physician', { type: 'respond', offerId, response: 'accept' }, { token: 'forged-token' }, physicianId);
    expect(forged.status).toBe(403);
    expect((await body(forged)).code).toBe('BAD_TOKEN');
  });

  it('unknown offer is 404 JSON', async () => {
    const r = await offerRoute.GET(req(`/api/offers/off-nope?t=${offerToken('off-nope')}`), params({ id: 'off-nope' }));
    expect(r.status).toBe(404);
    expect((await body(r)).code).toBe('UNKNOWN_OFFER');
  });
});

describe('POST /api/clock', () => {
  it('jump past the 10-minute expiry runs a tick that materializes offer_expired (OQ-36)', async () => {
    const offerId = await proposeTop();
    await command('clinical_lead', { type: 'approveOffer', offerId });
    const before = (await view()).logSeq;
    const r = await clock({ action: 'jump', to: '18:31' });
    expect(r.status).toBe(200);
    const v = await view();
    expect(v.offers[0]?.status).toBe('expired');
    expect(v.logSeq).toBe(before + 1);
    const audit = await body<{ outcome: { status: string; by: { role: string } | null } }>(await auditRoute.GET(req(`/api/audit/${offerId}`), params({ offerId })));
    expect(audit.outcome).toMatchObject({ status: 'expired', by: { role: 'system' } });
    // The physician's late accept is refused with the engine's reason.
    const late = await command('physician', { type: 'respond', offerId, response: 'accept' }, {}, v.offers[0]?.physicianId);
    expect(late.status).toBe(410);
    expect((await body(late)).code).toBe('EXPIRED');
  });

  it('advance, set speed, play and pause; bad input is 400', async () => {
    const start = (await view()).clock.nowMs;
    await clock({ action: 'advance', minutes: 5 });
    expect((await view()).clock.nowMs).toBe(start + 5 * 60_000);
    await clock({ action: 'advance', minutes: -5 });
    expect((await view()).clock.nowMs).toBe(start);
    const play = await body<{ clock: { mode: string; speed: number } }>(await clock({ action: 'play', speed: 60 }));
    expect(play.clock).toMatchObject({ mode: 'playing', speed: 60 });
    const pause = await body<{ clock: { mode: string } }>(await clock({ action: 'pause' }));
    expect(pause.clock.mode).toBe('paused');
    expect((await clock({ action: 'warp' })).status).toBe(400);
    expect((await clock({ action: 'play', speed: 7 })).status).toBe(400);
    expect((await clock({ action: 'jump', to: 'later' })).status).toBe(400);
  });
});

describe('persistence and reset', () => {
  it('a restart replays data/live (events and actions); reset clears it', async () => {
    const offerId = await proposeTop();
    expect(existsSync(join(await liveKeyDir(), 'actions.jsonl'))).toBe(true);
    disposeStore();
    const v = await view();
    expect(v.offers.map((o) => o.offerId)).toEqual([offerId]);
    await resetRoute.POST();
    expect((await view()).offers).toHaveLength(0);
    expect(existsSync(join(await liveKeyDir(), 'actions.jsonl'))).toBe(false);
    expect((await getReadyStore()).bootWarnings).toEqual([]);
  });
});

describe('GET /api/integrity and /api/stream', () => {
  it('integrity: correct 0 diffs, naive diffs, the late-event corrections and the slider subject', async () => {
    const b = await body<{ correct: { diffs: unknown[] }; naive: { diffs: unknown[] }; corrections: { eventId: string }[]; slider: { subject: { physicianId: string } | null; samples: unknown[] } }>(await integrityRoute.GET());
    expect(b.correct.diffs).toHaveLength(0);
    expect(b.naive.diffs.length).toBeGreaterThan(0);
    expect(b.corrections.length).toBeGreaterThan(0);
    expect(b.slider.subject).not.toBeNull();
    expect(b.slider.samples).toHaveLength(21);
  });

  it('stream: hello with the version, then a message on each mutation', async () => {
    const ac = new AbortController();
    const res = await streamRoute.GET(req('/api/stream', { signal: ac.signal }));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readUntil = async (pred: (t: string) => boolean) => {
      while (!pred(text)) {
        const { value, done } = (await reader?.read()) ?? { done: true, value: undefined };
        if (done) break;
        text += dec.decode(value);
      }
    };
    await readUntil((t) => t.includes('"hello"'));
    await clock({ action: 'advance', minutes: 1 });
    await readUntil((t) => t.includes('"clock"'));
    expect(text).toMatch(/"type":"clock","version":\d+/);
    ac.abort();
  });
});
