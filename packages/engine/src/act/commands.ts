import { decide, offerFromEntry, type DecisionReport } from '../decide';
import { DECISION_RIGHTS, MAX_OFFERS_PER_WEEK, MAX_OPEN_OFFERS_PER_PHYSICIAN, type Actor } from '../decide/brief-rules';
import { isoWeekStartEt } from '../decide/eligibility';
import { OFFER_MESSAGE_VOCABULARY } from '../decide/offerText';
import { findPhiViolations } from '../decide/phi';
import type { LedgerEntry, Need } from '../decide/types';
import { compareNeeds, needsOverDecisionHorizon, projectWithOffersFrom } from '../decide/whatif';
import { detect } from '../detect';
import { projectCoverage } from '../detect/coverage';
import { chooseRoute, routableNow } from '../detect/routing';
import { etClockS, type AcceptedOffer } from '../detect/staffing';
import { DECISION_HORIZON_MIN, ELIGIBILITY_NEED_KINDS, OFFER_CANCEL_ROLES, OFFER_DISPATCH_MODE, PARALLEL_OFFER_K, PROJECTION_STEP_MIN } from '../policy';
import type { Dataset, EpochMs } from '../types';
import { fnv1a } from '../util/hash';
import { coverageEffectOf, fillStatus, frozenNeed } from './fill';
import { appendActions, eventsOfCommand, headSeq, type PendingAction } from './log';
import { acceptedOffersOf, effectiveStartMs, expiresAt, foldOffers, isExpired, isInFlight, offerLogEntries, statusOf, type OfferRecord } from './offers';
import type { ActionLog, ActorRef, Command, CommandResult, CommandType, CoverageEffect, ErrorCode, FrozenNeed, OfferProposal, Role } from './types';

/**
 * Pure command processor for the Act layer (brief "Problem to Solve" layer 3,
 * "Users and Decision Rights", "Notification and Safety Constraints").
 * applyCommand(ctx, log, command, nowMs) never mutates its inputs and never
 * touches Sevaro's event stream; it recomputes decide() at nowMs as needed.
 */

export interface ActContext {
  readonly dataset: Dataset;
  /** Overrides policy OFFER_DISPATCH_MODE (OQ-37). */
  readonly dispatchMode?: 'sequential' | 'parallel';
  /** Overrides policy PARALLEL_OFFER_K (OQ-37). */
  readonly parallelK?: number;
}

const toRole = (a: Actor | null): Role[] => (a === null ? [] : [a === 'off_shift_physician' ? 'physician' : a]);

/** Who may issue each command, derived from DECISION_RIGHTS (brief "Users and Decision Rights"). */
export const COMMAND_ROLES: Readonly<Record<CommandType, readonly Role[]>> = {
  proposeOffer: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.proposer),
  proposeSlot: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.proposer),
  approveOffer: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.approver),
  rejectOffer: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.approver),
  respond: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.acceptor),
  cancelOffer: OFFER_CANCEL_ROLES,
  tick: ['system'],
  raiseEscalation: toRole(DECISION_RIGHTS.ESCALATE_TO_CLINICAL_LEAD.proposer),
  authorizeEscalation: toRole(DECISION_RIGHTS.ESCALATE_TO_CLINICAL_LEAD.approver),
  requestReassignment: toRole(DECISION_RIGHTS.REASSIGN_CONSULT.proposer),
  // "Automated actions are permitted only for low-risk steps (for example, an internal alert to the coordinator)."
  sendInternalAlert: [...toRole(DECISION_RIGHTS.VERIFY_PRESENCE.proposer), 'coordinator'],
};

const SYSTEM: ActorRef = { role: 'system', id: 'act-engine' };
const DELIVERY: ActorRef = { role: 'system', id: 'delivery-sim' };

type Fail = { readonly ok: false; readonly code: ErrorCode; readonly message: string };
type Handled = { readonly payloads: readonly PendingAction[]; readonly coverage?: CoverageEffect };
const fail = (code: ErrorCode, message: string): Fail => ({ ok: false, code, message });
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && 'ok' in x;

export function applyCommand(ctx: ActContext, log: ActionLog, command: Command, nowMs: EpochMs): CommandResult {
  // Idempotency: a commandId already in the log returns its original events; nothing is appended.
  const prior = eventsOfCommand(log, command.commandId);
  if (prior.length > 0) {
    const accepted = prior.find((e) => e.type === 'offer_accepted');
    return { ok: true, log, emitted: prior, replayed: true, coverage: accepted?.type === 'offer_accepted' ? accepted.payload.coverageEffect : null };
  }
  if (!COMMAND_ROLES[command.type].includes(command.actor.role)) {
    return fail('FORBIDDEN_ROLE', `${command.actor.role} may not ${command.type} (allowed: ${COMMAND_ROLES[command.type].join(', ')}; brief "Users and Decision Rights")`);
  }
  if (command.expectedSeq !== undefined && command.expectedSeq !== headSeq(log)) return fail('CONFLICT', `log is at seq ${headSeq(log)}, command expected ${command.expectedSeq}`);
  const head = log.at(-1);
  if (head !== undefined && nowMs < head.atMs) return fail('INVALID_STATE', `sim clock ${nowMs} is before the last action (${head.atMs}); the log is append-only in time`);
  const out = handle(ctx, log, command, nowMs);
  if (isFail(out)) return out;
  const { log: next, emitted } = appendActions(log, nowMs, command.actor, command.commandId, out.payloads);
  return { ok: true, log: next, emitted, replayed: false, coverage: out.coverage ?? null };
}

function handle(ctx: ActContext, log: ActionLog, c: Command, nowMs: EpochMs): Handled | Fail {
  switch (c.type) {
    case 'proposeOffer':
      return proposeOffer(ctx, log, c, nowMs);
    case 'proposeSlot':
      return proposeSlot(ctx, log, c, nowMs);
    case 'approveOffer':
      return approveOffer(log, c, nowMs);
    case 'rejectOffer':
      return withOffer(log, c.offerId, nowMs, (r, status) => (status === 'proposed' ? { payloads: [{ type: 'offer_rejected', payload: { offerId: r.offerId, reason: c.reason ?? 'rejected by the clinical lead' } }] } : wrongState(r, status, 'reject')));
    case 'respond':
      return respond(ctx, log, c, nowMs);
    case 'cancelOffer':
      return cancelOffer(log, c, nowMs);
    case 'tick':
      return tick(log, nowMs);
    case 'raiseEscalation':
      return raiseEscalation(c);
    case 'authorizeEscalation':
      return authorizeEscalation(log, c);
    case 'requestReassignment':
      return requestReassignment(ctx, log, c, nowMs);
    case 'sendInternalAlert':
      if (c.message.trim() === '') return fail('INVALID_STATE', 'empty alert');
      return { payloads: [{ type: 'internal_alert_sent', payload: { alertId: `alert-${fnv1a(c.commandId)}`, message: c.message, physicianIds: c.physicianIds ?? [], automated: c.actor.role === 'system' } }] };
  }
}

// ---------------------------------------------------------------- shared helpers

const dispatchMode = (ctx: ActContext) => ctx.dispatchMode ?? OFFER_DISPATCH_MODE;

/** decide() at nowMs with the action log as its offer log and accepted offers as staffing (scope + seed honoured). */
export function decideWithLog(ctx: ActContext, log: ActionLog, nowMs: EpochMs, accepted: readonly AcceptedOffer[] = acceptedOffersOf(log, nowMs)): DecisionReport {
  return decide(ctx.dataset, nowMs, { offerLog: offerLogEntries(log, nowMs), acceptedOffers: accepted });
}

/** Needs over the decision projection with no accepted offer staffed: what offers were proposed against. */
function baseNeeds(dataset: Dataset, nowMs: EpochMs): Need[] {
  const d = detect(dataset, nowMs);
  const cov = projectCoverage(dataset, d.state, d.staffing, d.demand, nowMs, { horizonMin: Math.max(DECISION_HORIZON_MIN, d.horizonMin), stepMin: PROJECTION_STEP_MIN }, d.routability);
  return needsOverDecisionHorizon(d, cov);
}

function withOffer(log: ActionLog, offerId: string, nowMs: EpochMs, f: (r: OfferRecord, status: ReturnType<typeof statusOf>) => Handled | Fail): Handled | Fail {
  const r = foldOffers(log, nowMs).find((x) => x.offerId === offerId);
  return r === undefined ? fail('UNKNOWN_OFFER', `no offer ${offerId}`) : f(r, statusOf(r, nowMs));
}

function wrongState(r: OfferRecord, status: string, verb: string): Fail {
  if (status === 'cancelled' || status === 'superseded') return fail('NO_LONGER_AVAILABLE', `offer ${r.offerId} is ${status}`);
  return fail('INVALID_STATE', `cannot ${verb} offer ${r.offerId} in state ${status}`);
}

/** Brief: "No more than one open offer per physician, and no more than 3 offers per physician per week" (OQ-09, OQ-41). */
function capCheck(log: ActionLog, physicianId: string, nowMs: EpochMs): Fail | null {
  const open = foldOffers(log, nowMs).filter((r) => r.proposal.physicianId === physicianId && isInFlight(r, nowMs));
  if (open.length >= MAX_OPEN_OFFERS_PER_PHYSICIAN) return fail('OPEN_OFFER_EXISTS', `${physicianId} already has open offer ${open.map((r) => r.offerId).join(', ')} (max ${MAX_OPEN_OFFERS_PER_PHYSICIAN})`);
  const weekStart = isoWeekStartEt(nowMs);
  const week = offerLogEntries(log, nowMs).filter((o) => o.physicianId === physicianId && o.sentMs >= weekStart && o.sentMs <= nowMs);
  if (week.length >= MAX_OFFERS_PER_WEEK) return fail('WEEKLY_CAP', `${physicianId} has ${week.length} offers this ISO week (max ${MAX_OFFERS_PER_WEEK}; OQ-09, OQ-41)`);
  return null;
}

const failedRules = (e: LedgerEntry | undefined) =>
  e === undefined ? 'not in the ledger' : e.rules.filter((r) => r.pass === false).map((r) => `${r.rule}: ${r.detail}`).join('; ') || 'no failed rule';

const sameNeed = (a: FrozenNeed, b: FrozenNeed) => a.id === b.id || (a.hospitalId === b.hospitalId && a.kind === b.kind && a.startMs === b.startMs);

/**
 * Brief "stop sending offers once the gap is filled" (OQ-40): the needs an
 * offer would target, or NEED_ALREADY_FILLED. Requested ids resolve against the
 * needs as they were before any acceptance.
 */
function targetNeeds(ctx: ActContext, current: DecisionReport, accepted: readonly AcceptedOffer[], physicianId: string, needIds: readonly string[] | undefined, nowMs: EpochMs): readonly FrozenNeed[] | null | Fail {
  if (needIds === undefined && accepted.length === 0) return null;
  const base = accepted.length === 0 ? current.whatIf.before : baseNeeds(ctx.dataset, nowMs);
  const horizonEnd = current.decisionCoverage.horizonEndMs;
  const credentials = current.detection.staffing.credentials.get(physicianId) ?? new Set<string>();
  const wanted = needIds === undefined ? base.filter((n) => ELIGIBILITY_NEED_KINDS.includes(n.kind) && credentials.has(n.hospitalId) && n.startMs <= current.nowMs + current.detection.horizonMin * 60_000) : needIds.map((id) => base.find((n) => n.id === id));
  const missing = needIds?.filter((_, i) => wanted[i] === undefined) ?? [];
  if (missing.length > 0) return fail('INVALID_STATE', `unknown need(s) ${missing.join(', ')} at this instant`);
  const frozen = wanted.filter((n): n is Need => n !== undefined).map(frozenNeed);
  if (accepted.length === 0) return frozen;
  const status = frozen.map((n) => fillStatus(n, accepted, current.whatIf.before, horizonEnd));
  const filled = status.filter((s) => s.filled);
  const blocked = needIds === undefined ? frozen.length > 0 && filled.length === frozen.length : filled.length > 0;
  if (blocked) return fail('NEED_ALREADY_FILLED', `already filled by an accepted offer: ${filled.map((s) => s.detail).join('; ')}`);
  return needIds === undefined ? null : frozen;
}

/** OQ-37 sequential dispatch: one physician at a time per need. */
function sequentialConflict(ctx: ActContext, log: ActionLog, needs: readonly FrozenNeed[], nowMs: EpochMs): Fail | null {
  if (dispatchMode(ctx) !== 'sequential') return null;
  const clash = foldOffers(log, nowMs).find((r) => isInFlight(r, nowMs) && r.proposal.needs.some((n) => needs.some((m) => sameNeed(n, m))));
  return clash === undefined ? null : fail('INVALID_STATE', `sequential dispatch (OQ-37): offer ${clash.offerId} to ${clash.proposal.physicianId} is still open for an overlapping need`);
}

function proposal(current: DecisionReport, entry: LedgerEntry, needs: readonly FrozenNeed[], offerId: string, slotId: string, mode: 'sequential' | 'parallel', channel: string): OfferProposal | null {
  const offer = offerFromEntry(current.detection, current.ledger, entry);
  if (offer === null) return null;
  return {
    offerId,
    slotId,
    dispatchMode: mode,
    physicianId: entry.physicianId,
    name: entry.name,
    channel,
    decisionAtMs: current.nowMs,
    window: { startMs: offer.window.startMs, endMs: offer.window.endMs, minutesToOnline: offer.window.minutesToOnline, effectiveMinutes: offer.window.effectiveMinutes, bindingCap: offer.window.bindingCap },
    routingScope: offer.routingScope,
    hospitalNames: offer.routingScope.map((h) => current.detection.staffing.hospitalNames.get(h) ?? h),
    seededConsultCount: offer.seededConsultCount,
    value: offer.value,
    needs,
    ledger: current.ledger.map((e) => ({
      physicianId: e.physicianId,
      name: e.name,
      eligible: e.eligible,
      rank: e.rank,
      failedRules: e.rules.filter((r) => r.pass === false).map((r) => r.rule),
      rules: e.rules.map((r) => ({ rule: r.rule, pass: r.pass, detail: r.detail })),
    })),
    trapWhy: offer.trap.trapWhy,
    message: offer.message,
  };
}

const coveredNeeds = (current: DecisionReport, entry: LedgerEntry) =>
  entry.coversNeeds.map((id) => current.needs.find((n) => n.id === id)).filter((n): n is Need => n !== undefined).map(frozenNeed);

// ---------------------------------------------------------------- offers

function proposeOffer(ctx: ActContext, log: ActionLog, c: Extract<Command, { type: 'proposeOffer' }>, nowMs: EpochMs): Handled | Fail {
  const roster = ctx.dataset.offShiftRoster.find((p) => p.physicianId === c.physicianId);
  if (roster === undefined) return fail('NOT_ELIGIBLE', `${c.physicianId} is not on the off-shift roster`);
  const cap = capCheck(log, c.physicianId, nowMs);
  if (cap !== null) return cap;
  const accepted = acceptedOffersOf(log, nowMs);
  const current = decideWithLog(ctx, log, nowMs, accepted);
  const target = targetNeeds(ctx, current, accepted, c.physicianId, c.needIds, nowMs);
  if (isFail(target)) return target;
  const entry = current.ledger.find((e) => e.physicianId === c.physicianId);
  if (entry === undefined || !entry.eligible) return fail('NOT_ELIGIBLE', `${c.physicianId} is not eligible at this instant: ${failedRules(entry)}`);
  const uncovered = (target ?? []).filter((n) => !entry.coversNeeds.includes(n.id));
  if (uncovered.length > 0) return fail('NOT_ELIGIBLE', `${c.physicianId}'s offer would not cover ${uncovered.map((n) => `${n.kind} ${n.hospitalId}`).join(', ')}`);
  const needs = target ?? coveredNeeds(current, entry);
  const conflict = sequentialConflict(ctx, log, needs, nowMs);
  if (conflict !== null) return conflict;
  const mode = dispatchMode(ctx);
  if (c.slotId !== undefined && mode !== 'parallel') return fail('INVALID_STATE', 'slots are only used in parallel dispatch (OQ-37)');
  const offerId = `off-${fnv1a(`${c.commandId}|${c.physicianId}`)}`;
  const p = proposal(current, entry, needs, offerId, c.slotId ?? `slot-${offerId}`, mode, roster.preferredChannel);
  return p === null ? fail('NOT_ELIGIBLE', `${c.physicianId}: no offer window`) : { payloads: [{ type: 'offer_proposed', payload: p }] };
}

/** OQ-37 parallel dispatch: one slot offered to the top-K eligible physicians at once. */
function proposeSlot(ctx: ActContext, log: ActionLog, c: Extract<Command, { type: 'proposeSlot' }>, nowMs: EpochMs): Handled | Fail {
  if (dispatchMode(ctx) !== 'parallel') return fail('INVALID_STATE', 'proposeSlot requires parallel dispatch (OQ-37)');
  const accepted = acceptedOffersOf(log, nowMs);
  const current = decideWithLog(ctx, log, nowMs, accepted);
  const k = c.k ?? ctx.parallelK ?? PARALLEL_OFFER_K;
  const slotId = `slot-${fnv1a(c.commandId)}`;
  const chosen = current.ledger
    .filter((e) => e.eligible && capCheck(log, e.physicianId, nowMs) === null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .slice(0, k);
  const payloads: PendingAction[] = [];
  for (const entry of chosen) {
    const target = targetNeeds(ctx, current, accepted, entry.physicianId, c.needIds, nowMs);
    if (isFail(target)) return target;
    const needs = (target ?? coveredNeeds(current, entry)).filter((n) => entry.coversNeeds.includes(n.id) || target === null);
    const channel = ctx.dataset.offShiftRoster.find((r) => r.physicianId === entry.physicianId)?.preferredChannel ?? 'unknown';
    const p = proposal(current, entry, needs, `off-${fnv1a(`${c.commandId}|${entry.physicianId}`)}`, slotId, 'parallel', channel);
    if (p !== null && needs.length > 0) payloads.push({ type: 'offer_proposed', payload: p });
  }
  return payloads.length === 0 ? fail('NOT_ELIGIBLE', 'no eligible physician for this slot') : { payloads };
}

/** Brief: "Every offer is approved by the clinical lead on duty before it is sent"; "No patient information in any notification." */
function approveOffer(log: ActionLog, c: Extract<Command, { type: 'approveOffer' }>, nowMs: EpochMs): Handled | Fail {
  return withOffer(log, c.offerId, nowMs, (r, status) => {
    if (status !== 'proposed') return wrongState(r, status, 'approve');
    const p = r.proposal;
    const violations = findPhiViolations(p.message, { allowedWords: OFFER_MESSAGE_VOCABULARY, allowedPhrases: p.hospitalNames });
    if (violations.length > 0) return fail('PHI_BLOCKED', `message blocked at send time: ${violations.map((v) => `"${v.token}" (${v.label})`).join(', ')}`);
    return {
      payloads: [
        { type: 'offer_approved', payload: { offerId: r.offerId, note: c.note ?? null } },
        { type: 'offer_sent', actor: DELIVERY, payload: { offerId: r.offerId, channel: p.channel, message: p.message } },
        { type: 'offer_delivered', actor: DELIVERY, payload: { offerId: r.offerId, channel: p.channel, simulated: true, expiresAtMs: expiresAt(nowMs) } },
      ],
    };
  });
}

function respond(ctx: ActContext, log: ActionLog, c: Extract<Command, { type: 'respond' }>, nowMs: EpochMs): Handled | Fail {
  return withOffer(log, c.offerId, nowMs, (r, status) => {
    // Brief: the off-shift physician can "Accept or decline from a phone; nothing else" - and only their own offer.
    if (c.actor.id !== r.proposal.physicianId || c.physicianId !== r.proposal.physicianId) return fail('NOT_OWN_OFFER', `offer ${r.offerId} was made to ${r.proposal.physicianId}`);
    if (status === 'expired') return fail('EXPIRED', `offer ${r.offerId} expired at ${r.delivered === null ? '?' : `${etClockS(expiresAt(r.delivered.atMs))} ET`} (brief: "expire if not answered within 10 minutes", OQ-36)`);
    if (status === 'cancelled' || status === 'superseded') return fail('NO_LONGER_AVAILABLE', `offer ${r.offerId} is ${status}`);
    if (status !== 'delivered') return fail('INVALID_STATE', `cannot respond to offer ${r.offerId} in state ${status}`);
    return c.response === 'decline' ? { payloads: [{ type: 'offer_declined', payload: { offerId: r.offerId } }] } : accept(ctx, log, r, nowMs);
  });
}

/**
 * Brief "Act": "update projected coverage when someone accepts; stop sending
 * offers once the gap is filled" and "Handle the case where two physicians
 * accept the same offer": same-slot offers are superseded, other open offers
 * whose needs are all filled are cancelled.
 */
function accept(ctx: ActContext, log: ActionLog, r: OfferRecord, nowMs: EpochMs): Handled {
  const p = r.proposal;
  const prev = acceptedOffersOf(log, nowMs);
  const mine: AcceptedOffer = { physicianId: p.physicianId, name: p.name, startMs: effectiveStartMs(p, nowMs), endMs: p.window.endMs, scopeHospitalIds: p.routingScope, seededConsultCount: p.seededConsultCount };
  const current = decideWithLog(ctx, log, nowMs, prev);
  const horizonEnd = current.decisionCoverage.horizonEndMs;
  const after = projectWithOffersFrom(ctx.dataset, current.detection, [mine], Math.round((horizonEnd - nowMs) / 60_000));
  const all = [...prev, mine];
  const filled = (needs: readonly FrozenNeed[]) => needs.map((n) => fillStatus(n, all, after.needs, horizonEnd));
  const effect = coverageEffectOf(compareNeeds(current.whatIf.before, after.needs, horizonEnd), after.routableAtOfferStart, filled(p.needs).filter((s) => s.filled).map((s) => s.needId));
  const others = foldOffers(log, nowMs).filter((o) => o.offerId !== r.offerId && isInFlight(o, nowMs));
  const superseded: PendingAction[] = others
    .filter((o) => o.proposal.slotId === p.slotId)
    .map((o) => ({ type: 'offer_superseded', actor: SYSTEM, payload: { offerId: o.offerId, slotId: p.slotId, wonBy: r.offerId, reason: `slot filled by another physician (${p.physicianId} accepted first)` } }));
  const cancelled: PendingAction[] = others
    .filter((o) => o.proposal.slotId !== p.slotId && o.proposal.needs.length > 0)
    .flatMap((o) => {
      const s = filled(o.proposal.needs);
      return s.every((x) => x.filled) ? [{ type: 'offer_cancelled', actor: SYSTEM, payload: { offerId: o.offerId, reason: `gap filled: ${s.map((x) => x.detail).join('; ')}`, cause: 'gap_filled', filledBy: r.offerId } } as PendingAction] : [];
    });
  return {
    payloads: [{ type: 'offer_accepted', payload: { offerId: r.offerId, effectiveStartMs: mine.startMs, endMs: mine.endMs, coverageEffect: effect } }, ...superseded, ...cancelled],
    coverage: effect,
  };
}

function cancelOffer(log: ActionLog, c: Extract<Command, { type: 'cancelOffer' }>, nowMs: EpochMs): Handled | Fail {
  return withOffer(log, c.offerId, nowMs, (r, status) => {
    if (isInFlight(r, nowMs)) return { payloads: [{ type: 'offer_cancelled', payload: { offerId: r.offerId, reason: c.reason, cause: 'manual', filledBy: null } }] };
    if (status === 'accepted') return fail('INVALID_STATE', `offer ${r.offerId} was accepted; cancelling an accepted shift is out of scope (OQ-42)`);
    return wrongState(r, status, 'cancel');
  });
}

/** Materializes derived expiries (OQ-36) so the audit log shows them; idempotent. */
function tick(log: ActionLog, nowMs: EpochMs): Handled {
  const due = foldOffers(log, nowMs).filter((r) => r.delivered !== null && r.outcome === null && isExpired(r.delivered.atMs, nowMs));
  return { payloads: due.map((r) => ({ type: 'offer_expired', payload: { offerId: r.offerId, expiredAtMs: expiresAt(r.delivered?.atMs ?? nowMs) } })) };
}

// ---------------------------------------------------------------- escalation, reassignment

/** OQ-38: an escalation is a record raised by the coordinator and authorized by the clinical lead. */
function raiseEscalation(c: Extract<Command, { type: 'raiseEscalation' }>): Handled | Fail {
  const s = c.subject;
  if (s.needId === undefined && s.attentionItemId === undefined && (s.consultIds ?? []).length === 0 && (s.hospitalIds ?? []).length === 0) return fail('INVALID_STATE', 'an escalation needs a subject');
  return { payloads: [{ type: 'escalation_raised', payload: { escalationId: `esc-${fnv1a(c.commandId)}`, subject: s, reason: c.reason } }] };
}

function authorizeEscalation(log: ActionLog, c: Extract<Command, { type: 'authorizeEscalation' }>): Handled | Fail {
  if (!log.some((e) => e.type === 'escalation_raised' && e.payload.escalationId === c.escalationId)) return fail('INVALID_STATE', `no escalation ${c.escalationId}`);
  if (log.some((e) => e.type === 'escalation_authorized' && e.payload.escalationId === c.escalationId)) return fail('INVALID_STATE', `escalation ${c.escalationId} is already authorized`);
  return { payloads: [{ type: 'escalation_authorized', payload: { escalationId: c.escalationId, note: c.note ?? null } }] };
}

/** Brief: the coordinator can "Reassign consults". Recorded as a request to perform in Synapse; Sevaro state is never mutated. */
function requestReassignment(ctx: ActContext, log: ActionLog, c: Extract<Command, { type: 'requestReassignment' }>, nowMs: EpochMs): Handled | Fail {
  const d = detect(ctx.dataset, nowMs, { acceptedOffers: acceptedOffersOf(log, nowMs) });
  const consult = d.state.consults[c.consultId];
  if (consult === undefined || !consult.open || consult.hospitalId === null) return fail('INVALID_STATE', `${c.consultId} is not an open consult with a hospital at this instant`);
  if (consult.assignedPhysicianId === c.toPhysicianId) return fail('INVALID_STATE', `${c.consultId} is already assigned to ${c.toPhysicianId}`);
  const choice = chooseRoute(d.state, d.staffing, consult.hospitalId, nowMs, { forConsultId: c.consultId });
  const candidate = choice.ranked.find((x) => x.physicianId === c.toPhysicianId);
  if (candidate === undefined) {
    const reasons = routableNow(d.state, d.staffing, c.toPhysicianId, consult.hospitalId, nowMs, { forConsultId: c.consultId }).reasons.filter((x) => !x.pass && x.affects === 'routable');
    return fail('NOT_ELIGIBLE', `${c.toPhysicianId} is not routable for ${c.consultId}: ${reasons.map((x) => x.detail).join('; ') || 'not a candidate'}`);
  }
  return {
    payloads: [
      {
        type: 'reassignment_requested',
        payload: { consultId: c.consultId, hospitalId: consult.hospitalId, fromPhysicianId: consult.assignedPhysicianId, toPhysicianId: c.toPhysicianId, label: 'requested in Synapse', why: candidate.why },
      },
    ],
  };
}

// ---------------------------------------------------------------- sequential: next candidate

/**
 * OQ-37/OQ-43: the next physician to offer after a decline, an expiry or a
 * rejection: top-ranked eligible, no open offer, and (REOFFER_AFTER_DECLINE =
 * false) not already declined/expired/rejected for an overlapping need.
 */
export function recommendNext(ctx: ActContext, log: ActionLog, nowMs: EpochMs): { readonly physicianId: string | null; readonly why: readonly string[] } {
  const current = decideWithLog(ctx, log, nowMs);
  const offers = foldOffers(log, nowMs);
  const spent = offers.filter((r) => ['declined', 'expired', 'rejected'].includes(statusOf(r, nowMs)));
  const why: string[] = [];
  for (const e of current.ledger.filter((x) => x.eligible).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))) {
    const needs = coveredNeeds(current, e);
    const prior = spent.find((r) => r.proposal.physicianId === e.physicianId && r.proposal.needs.some((n) => needs.some((m) => sameNeed(n, m))));
    if (prior !== undefined) {
      why.push(`${e.physicianId}: skipped, offer ${prior.offerId} for an overlapping need was ${statusOf(prior, nowMs)} (OQ-43)`);
      continue;
    }
    if (offers.some((r) => r.proposal.physicianId === e.physicianId && isInFlight(r, nowMs))) {
      why.push(`${e.physicianId}: skipped, offer already open`);
      continue;
    }
    return { physicianId: e.physicianId, why: [...why, `${e.physicianId}: rank ${e.rank}, eligible`] };
  }
  const ineligible = current.ledger.filter((x) => !x.eligible).map((x) => `${x.physicianId}: ${x.rules.filter((r) => r.pass === false).map((r) => r.rule).join(', ')}`);
  return { physicianId: null, why: [...why, 'no further eligible physician: keep the escalation with the clinical lead', ...ineligible] };
}
