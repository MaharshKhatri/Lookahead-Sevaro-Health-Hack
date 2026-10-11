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
import { DECISION_HORIZON_MIN, ELIGIBILITY_NEED_KINDS, OFFER_CANCEL_ROLES, OFFER_DISPATCH_MODE, PARALLEL_OFFER_K, PROJECTION_STEP_MIN, STANDBY_ACTIVATE_LEAD_MIN, STANDBY_ACTIVATE_PGAP, STANDBY_RELEASE_PGAP } from '../policy';
import type { Dataset, EpochMs } from '../types';
import { fnv1a } from '../util/hash';
import { analyzeTrap } from '../decide/trap';
import type { HawkesFit } from '../forecast';
import {
  activationMessage,
  preAlertMessage,
  activationTrigger,
  activationLapsed,
  foldStandbys,
  planFromDecision,
  phiCheck,
  quietAt,
  RECOMPUTE_MS,
  releaseMessage,
  standbyIdOf,
  standbyInFlight,
  standbyStatus,
  type PlanContext,
  type StandbyRecord,
  type StandbyStatus,
} from './standby';
import { coverageEffectOf, fillStatus, frozenNeed } from './fill';
import { appendActions, eventsOfCommand, headSeq, type PendingAction } from './log';
import { acceptedOffersOf, effectiveStartMs, expiresAt, foldOffers, isExpired, isInFlight, offerLogEntries, statusOf, type OfferRecord } from './offers';
import type { ActionLog, ActorRef, Command, CommandResult, CommandType, CoverageEffect, ErrorCode, FrozenNeed, OfferProposal, Role, StandbyProposal } from './types';

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
  /** A memoized surge-forecast fit for this dataset version and minute (standby commands refit when absent). */
  readonly forecastFit?: HawkesFit;
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
  // Standby network (Phase 4): the same rights as a split-shift offer ("Any message to a physician outside their shift requires a human approval").
  proposeStandby: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.proposer),
  approveStandby: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.approver),
  rejectStandby: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.approver),
  respondStandby: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.acceptor),
  proposeActivation: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.proposer),
  approveActivation: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.approver),
  rejectActivation: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.approver),
  respondActivation: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.acceptor),
  releaseStandby: toRole(DECISION_RIGHTS.SPLIT_SHIFT_OFFER.approver),
  cancelStandby: OFFER_CANCEL_ROLES,
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
    case 'proposeStandby':
      return proposeStandby(ctx, log, c, nowMs);
    case 'approveStandby':
      return approveStandby(log, c, nowMs);
    case 'rejectStandby':
      return withStandby(log, c.standbyId, nowMs, (r, status) => (status === 'proposed' ? { payloads: [{ type: 'standby_rejected', payload: { standbyId: r.standbyId, reason: c.reason ?? 'rejected by the clinical lead' } }] } : wrongStandbyState(r, status, 'reject')));
    case 'respondStandby':
      return respondStandby(log, c, nowMs);
    case 'proposeActivation':
      return proposeActivation(ctx, log, c, nowMs);
    case 'approveActivation':
      return approveActivation(log, c, nowMs);
    case 'rejectActivation':
      return withStandby(log, c.standbyId, nowMs, (r, status) => (status === 'activation_proposed' ? { payloads: [{ type: 'standby_activation_rejected', payload: { standbyId: r.standbyId, reason: c.reason ?? 'activation rejected by the clinical lead' } }] } : wrongStandbyState(r, status, 'reject activation of')));
    case 'respondActivation':
      return respondActivation(ctx, log, c, nowMs);
    case 'releaseStandby':
      return releaseStandby(ctx, log, c, nowMs);
    case 'cancelStandby':
      return withStandby(log, c.standbyId, nowMs, (r, status) => (standbyInFlight(r, nowMs) && status !== 'activated' ? { payloads: [{ type: 'standby_cancelled', payload: { standbyId: r.standbyId, reason: c.reason } }] } : wrongStandbyState(r, status, 'cancel')));
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
  // OQ-48: an open standby (pre-alert or activation in flight) is the physician's one open offer.
  const openStandby = foldStandbys(log, nowMs).filter((r) => r.proposal.physicianId === physicianId && standbyInFlight(r, nowMs));
  if (open.length + openStandby.length >= MAX_OPEN_OFFERS_PER_PHYSICIAN) return fail('OPEN_OFFER_EXISTS', `${physicianId} already has open ${[...open.map((r) => `offer ${r.offerId}`), ...openStandby.map((r) => `standby ${r.standbyId}`)].join(', ')} (max ${MAX_OPEN_OFFERS_PER_PHYSICIAN}; OQ-48)`);
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
  const mine: AcceptedOffer = { physicianId: p.physicianId, name: p.name, startMs: effectiveStartMs(p, nowMs), endMs: p.window.endMs, scopeHospitalIds: p.routingScope, seededConsultCount: p.seededConsultCount };
  const { effect, followUps } = reliefEffects(ctx, log, mine, nowMs, { offerId: r.offerId, slotId: p.slotId, needs: p.needs });
  return {
    payloads: [{ type: 'offer_accepted', payload: { offerId: r.offerId, effectiveStartMs: mine.startMs, endMs: mine.endMs, coverageEffect: effect } }, ...followUps],
    coverage: effect,
  };
}

/**
 * Coverage effect of one new relief (an accepted offer or an activated
 * standby) plus the follow-ups the brief asks for: same-slot offers are
 * superseded ("two physicians accept the same offer") and other open offers
 * whose needs are all filled are cancelled ("stop sending offers once the gap
 * is filled", OQ-40).
 */
function reliefEffects(ctx: ActContext, log: ActionLog, mine: AcceptedOffer, nowMs: EpochMs, source: { offerId: string; slotId: string | null; needs: readonly FrozenNeed[] }): { effect: CoverageEffect; followUps: PendingAction[] } {
  const prev = acceptedOffersOf(log, nowMs);
  const current = decideWithLog(ctx, log, nowMs, prev);
  const horizonEnd = current.decisionCoverage.horizonEndMs;
  const after = projectWithOffersFrom(ctx.dataset, current.detection, [mine], Math.round((horizonEnd - nowMs) / 60_000));
  const all = [...prev, mine];
  const filled = (needs: readonly FrozenNeed[]) => needs.map((n) => fillStatus(n, all, after.needs, horizonEnd));
  const effect = coverageEffectOf(compareNeeds(current.whatIf.before, after.needs, horizonEnd), after.routableAtOfferStart, filled(source.needs).filter((s) => s.filled).map((s) => s.needId));
  const others = foldOffers(log, nowMs).filter((o) => o.offerId !== source.offerId && isInFlight(o, nowMs));
  const superseded: PendingAction[] = others
    .filter((o) => source.slotId !== null && o.proposal.slotId === source.slotId)
    .map((o) => ({ type: 'offer_superseded', actor: SYSTEM, payload: { offerId: o.offerId, slotId: source.slotId ?? '', wonBy: source.offerId, reason: `slot filled by another physician (${mine.physicianId} accepted first)` } }));
  const cancelled: PendingAction[] = others
    .filter((o) => (source.slotId === null || o.proposal.slotId !== source.slotId) && o.proposal.needs.length > 0)
    .flatMap((o) => {
      const s = filled(o.proposal.needs);
      return s.every((x) => x.filled) ? [{ type: 'offer_cancelled', actor: SYSTEM, payload: { offerId: o.offerId, reason: `gap filled: ${s.map((x) => x.detail).join('; ')}`, cause: 'gap_filled', filledBy: source.offerId } } as PendingAction] : [];
    });
  return { effect, followUps: [...superseded, ...cancelled] };
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
  const standbys = foldStandbys(log, nowMs);
  const prealerts: PendingAction[] = standbys
    .filter((r) => standbyStatus(r, nowMs) === 'expired' && r.prealertExpired === null && r.prealertDelivered !== null)
    .map((r) => ({ type: 'standby_expired', payload: { standbyId: r.standbyId, stage: 'prealert', expiredAtMs: expiresAt(r.prealertDelivered?.atMs ?? nowMs) } }));
  const activations: PendingAction[] = standbys
    .filter((r) => activationLapsed(r, nowMs))
    .map((r) => ({ type: 'standby_expired', payload: { standbyId: r.standbyId, stage: 'activation', expiredAtMs: expiresAt(r.activation?.delivered?.atMs ?? nowMs) } }));
  return { payloads: [...due.map((r): PendingAction => ({ type: 'offer_expired', payload: { offerId: r.offerId, expiredAtMs: expiresAt(r.delivered?.atMs ?? nowMs) } })), ...prealerts, ...activations] };
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

// ---------------------------------------------------------------- standby network (Phase 4.4)

function withStandby(log: ActionLog, standbyId: string, nowMs: EpochMs, f: (r: StandbyRecord, status: StandbyStatus) => Handled | Fail): Handled | Fail {
  const r = foldStandbys(log, nowMs).find((x) => x.standbyId === standbyId);
  return r === undefined ? fail('UNKNOWN_STANDBY', `no standby ${standbyId}`) : f(r, standbyStatus(r, nowMs));
}

function wrongStandbyState(r: StandbyRecord, status: string, verb: string): Fail {
  if (status === 'cancelled' || status === 'released') return fail('NO_LONGER_AVAILABLE', `standby ${r.standbyId} is ${status}`);
  if (status === 'expired') return fail('EXPIRED', `standby ${r.standbyId} pre-alert expired (brief: 10 minutes)`);
  return fail('INVALID_STATE', `cannot ${verb} standby ${r.standbyId} in state ${status}`);
}

/** The standby plan at nowMs over the log (decide with the log's offers and activated standbys; forecast fit from ctx when memoized). */
export function planWithLog(ctx: ActContext, log: ActionLog, nowMs: EpochMs): PlanContext & { decision: DecisionReport } {
  const accepted = acceptedOffersOf(log, nowMs);
  const decision = decideWithLog(ctx, log, nowMs, accepted);
  return { ...planFromDecision(ctx.dataset, decision, log, nowMs, offerLogEntries(log, nowMs), accepted, ctx.forecastFit), decision };
}

/** 4.4.1 Pre-alert proposal: the coordinator asks the lead to pre-alert one eligible candidate of the current plan. */
function proposeStandby(ctx: ActContext, log: ActionLog, c: Extract<Command, { type: 'proposeStandby' }>, nowMs: EpochMs): Handled | Fail {
  const roster = ctx.dataset.offShiftRoster.find((p) => p.physicianId === c.physicianId);
  if (roster === undefined) return fail('NOT_ELIGIBLE', `${c.physicianId} is not on the off-shift roster`);
  const cap = capCheck(log, c.physicianId, nowMs);
  if (cap !== null) return cap;
  const { plan } = planWithLog(ctx, log, nowMs);
  const cand = plan.candidates.find((x) => x.physicianId === c.physicianId);
  if (cand === undefined || !cand.eligible || cand.window === null) return fail('NOT_ELIGIBLE', `${c.physicianId} is not a standby candidate at this instant: ${cand?.failingRule?.rule ?? 'unknown'}: ${cand?.failingRule?.detail ?? ''}`);
  if (cand.coveredCells === 0) return fail('NOT_ELIGIBLE', `${c.physicianId} covers no gap-risk cell within ${etClockS(cand.window.startMs)}-${etClockS(cand.window.endMs)} ET`);
  const names = cand.coveredHospitals.map((h) => plan.hospitals.find((x) => x.hospitalId === h)?.hospitalName ?? h);
  const selected = plan.selected.find((x) => x.physicianId === c.physicianId);
  const covered = plan.cells.filter((x) => cand.coveredHospitals.includes(x.hospitalId) && x.pGap > 0 && x.coverableByOne && cand.window !== null && cand.window.startMs <= x.startMs && x.startMs < cand.window.endMs);
  const proposal: StandbyProposal = {
    standbyId: standbyIdOf(c.commandId, c.physicianId),
    physicianId: c.physicianId,
    name: cand.name,
    channel: roster.preferredChannel,
    decisionAtMs: nowMs,
    minutesToOnline: cand.minutesToOnline,
    window: { startMs: cand.window.startMs, endMs: cand.window.endMs, minutes: cand.window.minutes },
    coveredHospitalIds: cand.coveredHospitals,
    hospitalNames: names,
    coveredCells: covered.map((x) => ({ hospitalId: x.hospitalId, startMs: x.startMs, pGap: x.pGap })),
    pAccept: cand.pAccept,
    valueEUM: selected?.valueEUM ?? cand.valueEUM,
    falseAlarmChance: selected?.falseAlarmChance ?? Math.round((1 - Math.max(0, ...covered.map((x) => x.pGap))) * 1000) / 1000,
    candidates: plan.candidates.map((x) => ({ physicianId: x.physicianId, name: x.name, eligible: x.eligible, failingRule: x.failingRule, valueEUM: x.valueEUM, selectedRound: plan.selected.find((s) => s.physicianId === x.physicianId)?.round ?? null })),
    planWhy: [...plan.why, ...(selected?.why ?? [cand.reason])],
    message: '',
  };
  let message: string;
  try {
    message = preAlertMessageFor(proposal);
  } catch (e) {
    return fail('PHI_BLOCKED', e instanceof Error ? e.message : String(e));
  }
  return { payloads: [{ type: 'standby_proposed', payload: { ...proposal, message } }] };
}

const preAlertMessageFor = (p: StandbyProposal) => preAlertMessage({ hospitalNames: p.hospitalNames, startMs: p.window.startMs, endMs: p.window.endMs, minutesToOnline: p.minutesToOnline });

/** Brief: every message to an off-shift physician is approved by the clinical lead; the PHI guard runs again at send time. */
function approveStandby(log: ActionLog, c: Extract<Command, { type: 'approveStandby' }>, nowMs: EpochMs): Handled | Fail {
  return withStandby(log, c.standbyId, nowMs, (r, status) => {
    if (status !== 'proposed') return wrongStandbyState(r, status, 'approve');
    const p = r.proposal;
    const violations = phiCheck(p.message, p.hospitalNames);
    if (violations.length > 0) return fail('PHI_BLOCKED', `pre-alert blocked at send time: ${violations.join(', ')}`);
    return {
      payloads: [
        { type: 'standby_approved', payload: { standbyId: r.standbyId, note: c.note ?? null } },
        { type: 'standby_prealert_sent', actor: DELIVERY, payload: { standbyId: r.standbyId, channel: p.channel, message: p.message } },
        { type: 'standby_prealert_delivered', actor: DELIVERY, payload: { standbyId: r.standbyId, channel: p.channel, simulated: true, expiresAtMs: expiresAt(nowMs) } },
      ],
    };
  });
}

function respondStandby(log: ActionLog, c: Extract<Command, { type: 'respondStandby' }>, nowMs: EpochMs): Handled | Fail {
  return withStandby(log, c.standbyId, nowMs, (r, status) => {
    if (c.actor.id !== r.proposal.physicianId || c.physicianId !== r.proposal.physicianId) return fail('NOT_OWN_OFFER', `standby ${r.standbyId} was sent to ${r.proposal.physicianId}`);
    if (status === 'expired') return fail('EXPIRED', `standby ${r.standbyId} pre-alert expired at ${r.prealertDelivered === null ? '?' : `${etClockS(expiresAt(r.prealertDelivered.atMs))} ET`} (brief: 10 minutes)`);
    if (status === 'cancelled' || status === 'released') return fail('NO_LONGER_AVAILABLE', `standby ${r.standbyId} is ${status}`);
    if (status !== 'prealert_delivered') return fail('INVALID_STATE', `cannot answer standby ${r.standbyId} in state ${status}`);
    return { payloads: [{ type: c.response === 'ready' ? 'standby_acknowledged' : 'standby_declined', payload: { standbyId: r.standbyId } }] };
  });
}

/** 4.4.2-3 Activation: allowed while acknowledged and the trigger holds (or the coordinator overrides with a reason). */
function proposeActivation(ctx: ActContext, log: ActionLog, c: Extract<Command, { type: 'proposeActivation' }>, nowMs: EpochMs): Handled | Fail {
  return withStandby(log, c.standbyId, nowMs, (r, status) => {
    if (status !== 'acknowledged') return wrongStandbyState(r, status, 'activate');
    const p = r.proposal;
    if (nowMs >= p.window.endMs) return fail('INVALID_STATE', `standby window ended ${etClockS(p.window.endMs)} ET`);
    const { plan, decision } = planWithLog(ctx, log, nowMs);
    const deadlocked = decision.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => n.hospitalId);
    let trigger = activationTrigger(plan, p, nowMs, deadlocked);
    if (trigger === null) {
      if (c.force !== true) return fail('INVALID_STATE', `activation not recommended: no covered cell at ${p.coveredHospitalIds.join(', ')} has P(gap) >= ${STANDBY_ACTIVATE_PGAP} within ${p.minutesToOnline} + ${STANDBY_ACTIVATE_LEAD_MIN} min and none is deadlocked (pass force with a reason to override)`);
      trigger = { kind: 'coordinator_override', detail: c.reason ?? 'coordinator override', hospitalId: null, cellStartMs: null, pGap: null };
    }
    const logOnByMs = Math.max(p.window.startMs, nowMs + p.minutesToOnline * 60_000);
    // Scope = the covered gap hospitals; seed = median of on-shift peers there (OQ-35), via the existing trap analysis.
    const trap = analyzeTrap(decision.detection, { physicianId: p.physicianId, startMs: logOnByMs, scopeHospitalIds: p.coveredHospitalIds, source: 'split_shift_offer' });
    let message: string;
    try {
      message = activationMessage({ hospitalNames: p.hospitalNames, logOnByMs, endMs: p.window.endMs });
    } catch (e) {
      return fail('PHI_BLOCKED', e instanceof Error ? e.message : String(e));
    }
    return {
      payloads: [
        {
          type: 'standby_activation_proposed',
          payload: { standbyId: r.standbyId, trigger, logOnByMs, endMs: p.window.endMs, scopeHospitalIds: p.coveredHospitalIds, hospitalNames: p.hospitalNames, seededConsultCount: trap.seededConsultCount, trapWhy: trap.trapWhy, message },
        },
      ],
    };
  });
}

function approveActivation(log: ActionLog, c: Extract<Command, { type: 'approveActivation' }>, nowMs: EpochMs): Handled | Fail {
  return withStandby(log, c.standbyId, nowMs, (r, status) => {
    const a = r.activation;
    if (status !== 'activation_proposed' || a === null) return wrongStandbyState(r, status, 'approve activation of');
    const violations = phiCheck(a.proposed.payload.message, r.proposal.hospitalNames);
    if (violations.length > 0) return fail('PHI_BLOCKED', `activation blocked at send time: ${violations.join(', ')}`);
    return {
      payloads: [
        { type: 'standby_activation_approved', payload: { standbyId: r.standbyId, note: c.note ?? null } },
        { type: 'standby_activation_sent', actor: DELIVERY, payload: { standbyId: r.standbyId, channel: r.proposal.channel, message: a.proposed.payload.message } },
        { type: 'standby_activation_delivered', actor: DELIVERY, payload: { standbyId: r.standbyId, channel: r.proposal.channel, simulated: true, expiresAtMs: expiresAt(nowMs) } },
      ],
    };
  });
}

/** The physician accepts: the standby becomes a normal accepted split shift (scope + seed), with the same fill and cancel effects as an offer. */
function respondActivation(ctx: ActContext, log: ActionLog, c: Extract<Command, { type: 'respondActivation' }>, nowMs: EpochMs): Handled | Fail {
  return withStandby(log, c.standbyId, nowMs, (r, status) => {
    if (c.actor.id !== r.proposal.physicianId || c.physicianId !== r.proposal.physicianId) return fail('NOT_OWN_OFFER', `standby ${r.standbyId} belongs to ${r.proposal.physicianId}`);
    const a = r.activation;
    if (a !== null && activationLapsed(r, nowMs)) return fail('EXPIRED', `activation request expired at ${etClockS(expiresAt(a.delivered?.atMs ?? nowMs))} ET (brief: 10 minutes)`);
    if (status === 'activated') return fail('INVALID_STATE', `standby ${r.standbyId} is already activated (double accept refused)`);
    if (status !== 'activation_delivered' || a === null) return wrongStandbyState(r, status, 'answer the activation of');
    if (c.response === 'decline') return { payloads: [{ type: 'standby_activation_declined', payload: { standbyId: r.standbyId } }] };
    const pl = a.proposed.payload;
    // OQ-39: online no earlier than acceptance + time to come online.
    const effectiveStartMs = Math.max(pl.logOnByMs, nowMs + r.proposal.minutesToOnline * 60_000);
    const mine: AcceptedOffer = { physicianId: r.proposal.physicianId, name: r.proposal.name, startMs: effectiveStartMs, endMs: pl.endMs, scopeHospitalIds: pl.scopeHospitalIds, seededConsultCount: pl.seededConsultCount };
    const { effect, followUps } = reliefEffects(ctx, log, mine, nowMs, { offerId: r.standbyId, slotId: null, needs: [] });
    return {
      payloads: [{ type: 'standby_activated', payload: { standbyId: r.standbyId, effectiveStartMs, endMs: pl.endMs, scopeHospitalIds: pl.scopeHospitalIds, seededConsultCount: pl.seededConsultCount, coverageEffect: effect } }, ...followUps],
      coverage: effect,
    };
  });
}

/** 4.4.4 Release: the clinical lead stands the physician down (recommended after two quiet recomputes; allowed any time while acknowledged). */
function releaseStandby(ctx: ActContext, log: ActionLog, c: Extract<Command, { type: 'releaseStandby' }>, nowMs: EpochMs): Handled | Fail {
  return withStandby(log, c.standbyId, nowMs, (r, status) => {
    if (status !== 'acknowledged') return wrongStandbyState(r, status, 'release');
    const message = releaseMessage({ startMs: r.proposal.window.startMs, endMs: r.proposal.window.endMs });
    const { plan } = planWithLog(ctx, log, nowMs);
    const quiet = quietAt(plan, r.proposal, nowMs);
    const reason = c.reason ?? (quiet ? `risk faded: no covered cell at P(gap) >= ${STANDBY_RELEASE_PGAP} remains` : 'released by the clinical lead');
    return { payloads: [{ type: 'standby_released', payload: { standbyId: r.standbyId, reason, message } }] };
  });
}

/** 4.4.4 Stand-down recommendation with hysteresis: quiet now and quiet one recompute step (5 min) earlier (OQ-51). */
export function standDownRecommended(ctx: ActContext, log: ActionLog, standbyId: string, nowMs: EpochMs): { readonly recommended: boolean; readonly quietNow: boolean; readonly quietBefore: boolean } {
  const r = foldStandbys(log, nowMs).find((x) => x.standbyId === standbyId);
  if (r === undefined) return { recommended: false, quietNow: false, quietBefore: false };
  const quietNow = quietAt(planWithLog(ctx, log, nowMs).plan, r.proposal, nowMs);
  if (!quietNow) return { recommended: false, quietNow, quietBefore: false };
  const before = nowMs - RECOMPUTE_MS;
  const quietBefore = before > r.proposed.atMs ? quietAt(planWithLog(ctx, log, before).plan, r.proposal, before) : false;
  return { recommended: quietNow && quietBefore, quietNow, quietBefore };
}

/** 4.4.2 Activation recommendation for an acknowledged standby, on the current plan. */
export function activationRecommended(ctx: ActContext, log: ActionLog, standbyId: string, nowMs: EpochMs): ReturnType<typeof activationTrigger> {
  const r = foldStandbys(log, nowMs).find((x) => x.standbyId === standbyId);
  if (r === undefined || standbyStatus(r, nowMs) !== 'acknowledged') return null;
  const { plan, decision } = planWithLog(ctx, log, nowMs);
  return activationTrigger(plan, r.proposal, nowMs, decision.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => n.hospitalId));
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
