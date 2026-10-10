/**
 * `pnpm demo:loop [dataDir] [outFile]`: narrates the closed loop (brief
 * "What Teams Must Demonstrate" #6: propose, approve, send (simulated), accept
 * or decline, update projected coverage) with real engine output at sim times,
 * plus the decline and no-response branches. Writes the transcript to
 * docs/ACT_LOOP.md. Every number comes from decide()/applyCommand().
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DateTime } from 'luxon';
import {
  ET_ZONE,
  applyCommand,
  auditCsv,
  auditTrail,
  decide,
  decideWithLog,
  etDateOf,
  etWallClockToEpoch,
  listOffers,
  offerState,
  recommendNext,
  snapshotAsOfMs,
  type ActContext,
  type ActionLog,
  type Command,
  type CommandResult,
} from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';

const dataDir = process.argv[2] ?? 'data/raw';
const outPath = process.argv[3] ?? 'docs/ACT_LOOP.md';
const dataset = loadDataset(dataDir);
const snapshot = snapshotAsOfMs(dataset);
if (snapshot === null) throw new Error('no snapshot instant');
const day = etDateOf(snapshot);
const at = (hms: string) => {
  const [h = '0', m = '0', s = '0'] = hms.split(':');
  return etWallClockToEpoch(day, Number(h) * 3600 + Number(m) * 60 + Number(s));
};
const hm = (ms: number) => DateTime.fromMillis(ms, { zone: ET_ZONE }).toFormat('HH:mm:ss');
const end = (e: number | 'beyond_horizon') => (e === 'beyond_horizon' ? 'beyond' : hm(e));
const out: string[] = [];
const say = (s = '') => {
  out.push(s);
  console.log(s);
};

const ctx: ActContext = { dataset };
const COORD = { role: 'coordinator', id: 'coordinator-on-duty' } as const;
const LEAD = { role: 'clinical_lead', id: 'clinical-lead-on-duty' } as const;
const SYSTEM = { role: 'system', id: 'scheduler' } as const;

function step(log: ActionLog, c: Command, hms: string, label: string): { log: ActionLog; r: CommandResult } {
  const r = applyCommand(ctx, log, c, at(hms));
  if (r.ok) {
    say(`[${hms}] ${label}: OK -> ${r.emitted.map((e) => `${e.type}#${e.seq}`).join(', ')}`);
    return { log: r.log, r };
  }
  say(`[${hms}] ${label}: REFUSED ${r.code}: ${r.message}`);
  return { log, r };
}

// ---------------------------------------------------------------- 18:20 detect + decide
const d0 = decide(dataset, at('18:20:00'));
say('=== HAPPY PATH ===');
say(`[18:20:00] Detect: top issue "${d0.recommendation?.headline}"`);
for (const line of d0.recommendation?.rationale ?? []) say(`           - ${line}`);
say(`           eligible: ${d0.ledger.filter((e) => e.eligible).map((e) => e.physicianId).join(', ')}; excluded: ${d0.ledger.filter((e) => !e.eligible).map((e) => `${e.physicianId} (${e.rules.filter((r) => r.pass === false).map((r) => r.rule).join(' + ')})`).join(', ')}`);

const top = d0.recommendedOffer?.physicianId ?? '';
let log: ActionLog = [];
({ log } = step(log, { type: 'proposeOffer', commandId: 'demo-propose', actor: COORD, physicianId: top }, '18:21:00', `coordinator proposes ${top}`));
const offer = listOffers(log, at('18:21:00'))[0];
if (offer === undefined) throw new Error('no offer proposed');
const proposed = log[0]?.type === 'offer_proposed' ? log[0].payload : null;
say(`           offer ${offer.offerId}: window ${hm(offer.window.startMs)}-${hm(offer.window.endMs)} ET (re-derived at 18:21: now + ${offer.window.minutesToOnline} min), scope ${offer.routingScope.join(', ')}, seeded at ${offer.seededConsultCount}`);
say(`           needs: ${offer.needs.map((n) => `${n.kind} ${n.hospitalId} ${hm(n.startMs)}-${end(n.endMs)}`).join('; ')}`);
say(`           frozen ledger: ${proposed?.ledger.length} physicians considered, ${proposed?.ledger.filter((x) => x.eligible).length} eligible`);

({ log } = step(log, { type: 'approveOffer', commandId: 'demo-approve', actor: LEAD, offerId: offer.offerId }, '18:22:00', 'clinical lead approves'));
const sent = log.find((e) => e.type === 'offer_sent');
const delivered = log.find((e) => e.type === 'offer_delivered');
if (sent?.type === 'offer_sent' && delivered?.type === 'offer_delivered') {
  say(`           delivered (simulated) on ${delivered.payload.channel}; expires ${hm(delivered.payload.expiresAtMs)}; PHI check passed. Message:`);
  for (const line of sent.payload.message.split('\n')) say(`             | ${line}`);
}
const s23 = offerState(log, offer.offerId, at('18:23:00'));
say(`[18:23:00] offer state: ${s23?.status}, ${Math.round((s23?.msUntilExpiry ?? 0) / 1000)} s until expiry`);

const accepted = step(log, { type: 'respond', commandId: 'demo-accept', actor: { role: 'physician', id: top }, offerId: offer.offerId, physicianId: top, response: 'accept' }, '18:24:00', `${top} accepts on phone`);
log = accepted.log;
if (accepted.r.ok && accepted.r.coverage !== null) {
  const acc = log.find((e) => e.type === 'offer_accepted');
  if (acc?.type === 'offer_accepted') say(`           counts as staffed from ${hm(acc.payload.effectiveStartMs)} (accepted 18:24 + ${offer.window.minutesToOnline} min to online, OQ-39) until ${hm(acc.payload.endMs)}; expected until shift_started (OQ-29)`);
  say('           coverage update (before -> after, 300-min decision projection):');
  for (const c of accepted.r.coverage.changes.filter((x) => x.outcome !== 'unchanged')) say(`             ${c.kind} ${c.hospitalId} ${hm(c.startMs)}-${end(c.endMs)}: ${c.outcome} (${c.detail})`);
  say(`             unchanged: ${accepted.r.coverage.changes.filter((x) => x.outcome === 'unchanged').length} needs`);
  say(`           routable at start: ${accepted.r.coverage.routableAtStart.map((x) => `${x.hospitalId} ${x.count} at ${hm(x.atMs)}`).join(', ')}`);
  say(`           needs filled (OQ-40): ${accepted.r.coverage.filledNeedIds.map((id) => offer.needs.find((n) => n.id === id)).map((n) => (n ? `${n.kind} ${n.hospitalId}` : '?')).join(', ')}`);
  const cancelled = accepted.r.emitted.filter((e) => e.type === 'offer_cancelled' || e.type === 'offer_superseded');
  say(`           open offers cancelled/superseded: ${cancelled.length === 0 ? 'none (sequential dispatch: no other open offer)' : cancelled.map((e) => e.type).join(', ')}`);
}
const deadlock10 = d0.needs.find((n) => n.kind === 'DEADLOCK_NOW' && n.hospitalId === 'SYN-010');
step(log, { type: 'proposeOffer', commandId: 'demo-propose-again', actor: COORD, physicianId: 'PHY-014', needIds: deadlock10 ? [deadlock10.id] : [] }, '18:25:00', 'coordinator proposes another offer for the SYN-010 deadlock');
const next = recommendNext(ctx, log, at('18:25:00'));
say(`[18:25:00] next candidate: ${next.physicianId ?? 'none'} (${next.why[0]})`);

for (const hms of ['18:35:00', '18:39:00']) {
  const d = decideWithLog(ctx, log, at(hms));
  say(`[${hms}] decide: routable now SYN-010 ${d.detection.coverage.routableNow['SYN-010'] ?? 0}, SYN-005 ${d.detection.coverage.routableNow['SYN-005'] ?? 0}; deadlocks ${d.detection.deadlocks.map((x) => x.consultId).join(', ') || 'none'}; DEADLOCK_NOW needs ${d.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => `${n.hospitalId} until ${end(n.endMs)}`).join(', ') || 'none'}`);
}
const trail = auditTrail(log, offer.offerId);
if (trail !== null) {
  say('');
  say('=== AUDIT TRAIL (from the frozen action log) ===');
  say(`offer ${trail.offerId} to ${trail.name} (${trail.physicianId}), slot ${trail.slotId}`);
  say(`considered ${trail.considered.length}: ${trail.considered.map((x) => `${x.physicianId} ${x.eligible ? `ELIGIBLE rank ${x.rank}` : `excluded (${x.failedRules.join(' + ')})`}`).join('; ')}`);
  for (const x of trail.excluded) say(`  excluded ${x.physicianId}: ${x.why.join(' | ')}`);
  say(`proposed by ${trail.proposed.by.role}:${trail.proposed.by.id} at ${hm(trail.proposed.atMs)}; approved by ${trail.approved?.by.role}:${trail.approved?.by.id} at ${trail.approved ? hm(trail.approved.atMs) : '-'}`);
  say(`sent ${trail.sentAtMs === null ? '-' : hm(trail.sentAtMs)} via ${trail.channel}; outcome ${trail.outcome.status} at ${trail.outcome.atMs === null ? '-' : hm(trail.outcome.atMs)} by ${trail.outcome.by?.role}:${trail.outcome.by?.id} (${trail.outcome.detail})`);
  say(`coverage effect: ${trail.coverageEffect?.filledNeedIds.length ?? 0} needs filled; cancellations caused: ${trail.cancellationsCaused.length}`);
  say('CSV:');
  for (const line of auditCsv(log).trim().split('\n')) say(`  ${line}`);
}

// ---------------------------------------------------------------- branch: decline
say('');
say('=== BRANCH: decline ===');
let logB: ActionLog = log.slice(0, 4); // proposed + approved/sent/delivered
({ log: logB } = step(logB, { type: 'respond', commandId: 'demo-decline', actor: { role: 'physician', id: top }, offerId: offer.offerId, physicianId: top, response: 'decline' }, '18:24:00', `${top} declines`));
const nextB = recommendNext(ctx, logB, at('18:24:00'));
say(`[18:24:00] next eligible: ${nextB.physicianId ?? 'none'}`);
for (const w of nextB.why) say(`           - ${w}`);
const topItem = d0.detection.attention[0];
({ log: logB } = step(logB, { type: 'raiseEscalation', commandId: 'demo-esc', actor: COORD, subject: { attentionItemId: topItem?.id ?? '', consultIds: [...(topItem?.consultIds ?? [])] }, reason: 'split-shift offer declined; no other eligible physician' }, '18:25:00', 'coordinator escalates'));
const esc = logB.find((e) => e.type === 'escalation_raised');
if (esc?.type === 'escalation_raised') ({ log: logB } = step(logB, { type: 'authorizeEscalation', commandId: 'demo-esc-auth', actor: LEAD, escalationId: esc.payload.escalationId, note: 'authorize physician-to-physician handoff' }, '18:26:00', 'clinical lead authorizes the escalation'));

// ---------------------------------------------------------------- branch: no response
say('');
say('=== BRANCH: no response ===');
let logC: ActionLog = log.slice(0, 4);
for (const hms of ['18:31:59', '18:32:00']) {
  const s = offerState(logC, offer.offerId, at(hms));
  say(`[${hms}] offer state: ${s?.status}${s?.msUntilExpiry === null ? '' : `, ${Math.round((s?.msUntilExpiry ?? 0) / 1000)} s left`}${s?.status === 'expired' ? ` (derived; materialized: ${s.expiryMaterialized})` : ''}`);
}
({ log: logC } = step(logC, { type: 'tick', commandId: 'demo-tick-1832', actor: SYSTEM }, '18:32:00', 'system tick'));
({ log: logC } = step(logC, { type: 'tick', commandId: 'demo-tick-1833', actor: SYSTEM }, '18:33:00', 'system tick again (idempotent)'));
step(logC, { type: 'respond', commandId: 'demo-late-accept', actor: { role: 'physician', id: top }, offerId: offer.offerId, physicianId: top, response: 'accept' }, '18:33:00', `${top} tries to accept late`);
const nextC = recommendNext(ctx, logC, at('18:33:00'));
say(`[18:33:00] next eligible: ${nextC.physicianId ?? 'none'} -> escalation stays with the clinical lead`);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  [
    '<!-- Generated by `pnpm demo:loop` (scripts/demo-loop.ts). Do not edit by hand. -->',
    '# Closed loop at 18:20 (Act layer)',
    '',
    'Real engine output at simulated times on the reference data package (brief "What Teams Must Demonstrate" #6). The action log is separate from Sevaro\'s event stream; delivery is simulated.',
    '',
    '```text',
    ...out,
    '```',
    '',
  ].join('\n'),
);
console.log(`\nwrote ${outPath}`);
