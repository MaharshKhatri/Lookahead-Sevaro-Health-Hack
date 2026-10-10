import 'server-only';
import {
  OFFER_MESSAGE_VOCABULARY,
  assertNoPHI,
  compareNeeds,
  decideWithLog,
  foldOffers,
  introducedNeeds,
  listOffers,
  offerFromEntry,
  projectWithOffersFrom,
  statusOf,
  type ActionLog,
  type ActorRef,
  type CoverageEffect,
  type Dataset,
  type DecisionReport,
  type Need,
  type NeedChange,
  type OfferRecord,
  type TrapAnalysis,
} from '@lookahead/engine';
import type { EscalationDTO, OfferDTO, PublicOfferDTO, TrapDTO, WhatIfDTO, WhatIfRowDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import type { StoreSnapshot } from './store';

/**
 * Offer read models for the UI, all folded from the action log by the engine
 * (listOffers / foldOffers, D-59). Nothing here changes state.
 */

export const who = (a: ActorRef | null | undefined): string | null => (a === null || a === undefined ? null : `${a.role}:${a.id}`);

export function offerDTOs(log: ActionLog, nowMs: number): OfferDTO[] {
  const records = new Map(foldOffers(log, nowMs).map((r) => [r.offerId, r]));
  return listOffers(log, nowMs).flatMap((v): OfferDTO[] => {
    const r = records.get(v.offerId);
    if (r === undefined) return [];
    const p = r.proposal;
    const o = r.outcome;
    const accepted = o?.event.type === 'offer_accepted' ? o.event.payload.coverageEffect : null;
    const outcome =
      o !== null
        ? { status: o.status, atMs: o.event.type === 'offer_expired' ? o.event.payload.expiredAtMs : o.atMs, by: who(o.by), detail: outcomeDetail(r) }
        : r.rejected !== null
          ? { status: 'rejected', atMs: r.rejected.atMs, by: who(r.rejected.by), detail: r.rejected.reason }
          : v.status === 'expired'
            ? { status: 'expired', atMs: v.expiresAtMs, by: null, detail: 'expired (derived; materialized at the next clock tick)' }
            : null;
    return [
      {
        offerId: v.offerId,
        slotId: v.slotId,
        physicianId: v.physicianId,
        name: v.name,
        status: v.status,
        needs: v.needs,
        window: v.window,
        routingScope: v.routingScope,
        hospitalNames: p.hospitalNames,
        seededConsultCount: v.seededConsultCount,
        value: p.value,
        channel: p.channel,
        message: r.sent?.message ?? p.message,
        trapWhy: p.trapWhy,
        ledger: p.ledger,
        proposedAtMs: v.proposedAtMs,
        proposedBy: who(r.proposed.by) ?? '',
        approvedAtMs: r.approved?.atMs ?? null,
        approvedBy: who(r.approved?.by),
        deliveredAtMs: v.deliveredAtMs,
        expiresAtMs: v.expiresAtMs,
        msUntilExpiry: v.msUntilExpiry,
        allowedActions: v.allowedActions,
        outcome,
        coverageEffect: accepted,
        offerPath: `/offer/${encodeURIComponent(v.offerId)}`,
      },
    ];
  });
}

function outcomeDetail(r: OfferRecord): string {
  const e = r.outcome?.event;
  if (e === undefined) return '';
  switch (e.type) {
    case 'offer_accepted':
      return `online from ${etHm(e.payload.effectiveStartMs)} until ${etHm(e.payload.endMs)} ET`;
    case 'offer_expired':
      return `expired at ${etHm(e.payload.expiredAtMs)} ET`;
    case 'offer_cancelled':
    case 'offer_superseded':
      return e.payload.reason;
    default:
      return e.type.replace('offer_', '');
  }
}

export function escalationDTOs(log: ActionLog, nowMs: number, headlineOf: (attentionId: string) => string | null): EscalationDTO[] {
  const known = log.filter((e) => e.atMs <= nowMs);
  return known.flatMap((e): EscalationDTO[] => {
    if (e.type !== 'escalation_raised') return [];
    const auth = known.find((x) => x.type === 'escalation_authorized' && x.payload.escalationId === e.payload.escalationId);
    const s = e.payload.subject;
    const targets = [...(s.consultIds ?? []), ...(s.hospitalIds ?? [])].join(', ');
    const headline = (s.attentionItemId === undefined ? null : headlineOf(s.attentionItemId)) ?? (targets === '' ? e.payload.reason : targets);
    return [
      {
        escalationId: e.payload.escalationId,
        subject: s,
        headline,
        reason: e.payload.reason,
        raisedAtMs: e.atMs,
        raisedBy: who(e.actor) ?? '',
        authorizedAtMs: auth?.atMs ?? null,
        authorizedBy: who(auth?.actor),
        note: auth?.type === 'escalation_authorized' ? auth.payload.note : null,
      },
    ];
  });
}

// ------------------------------------------------------------------ trap + what-if DTOs

export function trapDTO(t: TrapAnalysis, name: string | null): TrapDTO {
  return {
    physicianId: t.physicianId,
    name,
    startMs: t.startMs,
    dayShift: t.dayShift,
    lowVolumeLimit: t.lowVolumeLimit,
    credentialedHospitalIds: t.credentialedHospitalIds,
    scopeHospitalIds: t.scopeHospitalIds,
    credentialedOutsideScope: t.credentialedOutsideScope,
    before: t.before,
    after: t.after,
    seededConsultCount: t.seededConsultCount,
    seedBasis: t.seedBasis,
    recommended: t.recommended,
    trapWhy: t.trapWhy,
  };
}

const endOf = (n: { endMs: number | 'beyond_horizon' }, horizonEndMs: number) => (n.endMs === 'beyond_horizon' ? horizonEndMs : n.endMs);

export function whatIfRows(changes: readonly NeedChange[], horizonEndMs: number): WhatIfRowDTO[] {
  return changes.map((c) => {
    const b = c.before;
    const bEnd = endOf(b, horizonEndMs);
    const same = c.after.filter((a) => a.kind === b.kind);
    const remaining = same.reduce((m, a) => m + Math.max(0, Math.min(bEnd, endOf(a, horizonEndMs)) - Math.max(b.startMs, a.startMs)), 0);
    return {
      needId: b.id,
      kind: b.kind,
      hospitalId: b.hospitalId,
      hospitalName: b.hospitalName,
      startMs: b.startMs,
      endMs: b.endMs,
      outcome: c.outcome,
      detail: c.detail,
      beforeMinutes: Math.round((bEnd - b.startMs) / 60_000),
      remainingMinutes: c.outcome === 'closed' ? 0 : Math.round(remaining / 60_000),
      after: c.after.map((a) => ({ kind: a.kind, startMs: a.startMs, endMs: a.endMs })),
    };
  });
}

const introducedRows = (needs: readonly Need[]) => needs.map((n) => ({ kind: n.kind, hospitalId: n.hospitalId, startMs: n.startMs, endMs: n.endMs }));

/** decide()'s own what-if for the recommended offer. */
export function recommendedWhatIf(d: DecisionReport): WhatIfDTO {
  const o = d.recommendedOffer;
  const horizon = d.decisionCoverage.horizonEndMs;
  return {
    source: o === null ? 'none' : 'recommended',
    offerId: null,
    physicianId: o?.physicianId ?? null,
    name: o?.name ?? null,
    window: o === null ? null : { startMs: o.window.startMs, endMs: o.window.endMs },
    rows: whatIfRows(d.whatIf.changes, horizon),
    routableAtStart: (d.whatIf.after?.routableAtOfferStart ?? []).map((r) => ({ hospitalId: r.hospitalId, atMs: r.atMs, count: r.count })),
    introduced: introducedRows(d.whatIf.introduced),
    filledNeedIds: [],
  };
}

/** The frozen effect recorded in offer_accepted (D-58): what the acceptance changed. */
export function acceptedWhatIf(o: OfferDTO, effect: CoverageEffect, needNames: ReadonlyMap<string, string>): WhatIfDTO {
  return {
    source: 'accepted',
    offerId: o.offerId,
    physicianId: o.physicianId,
    name: o.name,
    window: { startMs: o.window.startMs, endMs: o.window.endMs },
    rows: effect.changes.map((c) => ({
      needId: c.needId,
      kind: c.kind,
      hospitalId: c.hospitalId,
      hospitalName: needNames.get(c.hospitalId) ?? c.hospitalId,
      startMs: c.startMs,
      endMs: c.endMs,
      outcome: c.outcome,
      detail: c.detail,
      beforeMinutes: Math.round(((c.endMs === 'beyond_horizon' ? c.startMs : c.endMs) - c.startMs) / 60_000),
      remainingMinutes: null,
      after: null,
    })),
    routableAtStart: effect.routableAtStart,
    introduced: [],
    filledNeedIds: effect.filledNeedIds,
  };
}

interface ProposalContext {
  readonly trap: TrapDTO | null;
  readonly whatIf: WhatIfDTO;
}

const contextCache = new Map<string, ProposalContext>();

/**
 * Trap and what-if for an offer as it was proposed: decide() at the proposal
 * instant over the log before the proposal (both immutable), the ledger entry
 * turned into the scoped, seeded offer (offerFromEntry), then the engine's
 * re-projection with that offer accepted. Cached per offer and dataset version.
 */
export function proposalContext(s: StoreSnapshot, offer: OfferDTO): ProposalContext {
  const key = `${s.bootId}|${s.datasetVersion}|${offer.offerId}`;
  const hit = contextCache.get(key);
  if (hit !== undefined) return hit;
  const proposedSeq = s.log.find((e) => e.type === 'offer_proposed' && e.payload.offerId === offer.offerId)?.seq ?? 1;
  const before = s.log.filter((e) => e.seq < proposedSeq);
  const value = computeProposalContext(s.dataset, before, offer);
  if (contextCache.size > 50) contextCache.clear();
  contextCache.set(key, value);
  return value;
}

function computeProposalContext(dataset: Dataset, logBefore: ActionLog, offer: OfferDTO): ProposalContext {
  const atMs = offer.proposedAtMs;
  const d = decideWithLog({ dataset }, logBefore, atMs);
  const entry = d.ledger.find((e) => e.physicianId === offer.physicianId);
  const rec = entry === undefined ? null : offerFromEntry(d.detection, d.ledger, entry);
  const horizon = d.decisionCoverage.horizonEndMs;
  const after = projectWithOffersFrom(
    dataset,
    d.detection,
    [{ physicianId: offer.physicianId, name: offer.name, startMs: offer.window.startMs, endMs: offer.window.endMs, scopeHospitalIds: offer.routingScope, seededConsultCount: offer.seededConsultCount }],
    Math.round((horizon - atMs) / 60_000),
  );
  return {
    trap: rec === null ? null : trapDTO(rec.trap, offer.name),
    whatIf: {
      source: 'proposed',
      offerId: offer.offerId,
      physicianId: offer.physicianId,
      name: offer.name,
      window: { startMs: offer.window.startMs, endMs: offer.window.endMs },
      rows: whatIfRows(compareNeeds(d.whatIf.before, after.needs, horizon), horizon),
      routableAtStart: after.routableAtOfferStart.map((r) => ({ hospitalId: r.hospitalId, atMs: r.atMs, count: r.count })),
      introduced: introducedRows(introducedNeeds(d.whatIf.before, after.needs, horizon)),
      filledNeedIds: [],
    },
  };
}

// ------------------------------------------------------------------ physician phone view

/**
 * GET /api/offers/:id (brief "Off-shift physician ... A clear offer:
 * hospitals, hours, start time, why they were asked"; "No patient information
 * in any notification"). Only the delivered message and plain-English state;
 * every string passes the engine's PHI guard (assertNoPHI) before it leaves.
 */
export function publicOffer(s: StoreSnapshot, offerId: string): PublicOfferDTO | null {
  const nowMs = s.clock.nowMs;
  const r = foldOffers(s.log, nowMs).find((x) => x.offerId === offerId);
  if (r === undefined) return null;
  const p = r.proposal;
  const status = statusOf(r, nowMs);
  const delivered = r.delivered !== null && r.sent !== null;
  const messageLines = delivered ? (r.sent?.message ?? '').split('\n') : null;
  if (messageLines !== null) assertNoPHI(messageLines.join('\n'), { allowedWords: OFFER_MESSAGE_VOCABULARY, allowedPhrases: p.hospitalNames });
  const expiresAtMs = r.delivered?.expiresAtMs ?? null;
  const { headline, reason } = plainState(r, status, expiresAtMs);
  for (const text of [headline, reason ?? '']) assertNoPHI(text);
  return {
    offerId,
    physicianId: p.physicianId,
    status,
    nowMs,
    clockMode: s.clock.mode,
    clockSpeed: s.clock.speed,
    messageLines,
    hospitals: delivered ? p.hospitalNames : [],
    startMs: p.window.startMs,
    endMs: p.window.endMs,
    expiresAtMs,
    msUntilExpiry: status === 'delivered' && expiresAtMs !== null ? expiresAtMs - nowMs : null,
    canRespond: status === 'delivered',
    headline,
    reason,
  };
}

function plainState(r: OfferRecord, status: string, expiresAtMs: number | null): { headline: string; reason: string | null } {
  const e = r.outcome?.event;
  switch (status) {
    case 'proposed':
    case 'approved':
    case 'sent':
      return { headline: 'Waiting for approval', reason: 'The operations team has not sent this offer yet.' };
    case 'delivered':
      return { headline: 'Split-shift offer', reason: null };
    case 'accepted':
      return { headline: 'Accepted. Thank you.', reason: e?.type === 'offer_accepted' ? `You are expected online from ${etHm(e.payload.effectiveStartMs)} until ${etHm(e.payload.endMs)} ET.` : null };
    case 'declined':
      return { headline: 'Declined', reason: 'You declined this offer. No further action is needed.' };
    case 'expired':
      return { headline: 'This offer expired', reason: `It was not answered within 10 minutes${expiresAtMs === null ? '' : ` (expired at ${etHm(expiresAtMs)} ET)`}.` };
    case 'cancelled':
      return e?.type === 'offer_cancelled' && e.payload.cause === 'gap_filled'
        ? { headline: 'This shift has been filled', reason: 'Another physician accepted cover for these hours. Thank you.' }
        : { headline: 'This offer was withdrawn', reason: 'The operations team withdrew this offer.' };
    case 'superseded':
      return { headline: 'This shift has been filled', reason: 'Another physician accepted first. Thank you.' };
    case 'rejected':
      return { headline: 'This offer was not sent', reason: 'The operations team withdrew this offer.' };
    default:
      return { headline: status, reason: null };
  }
}
