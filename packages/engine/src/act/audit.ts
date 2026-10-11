import { DateTime } from 'luxon';
import { ET_ZONE } from '../time';
import type { EpochMs } from '../types';
import { actionsKnownAt } from './log';
import { expiresAt, foldOffers, statusOf, type OfferRecord, type OfferStatus } from './offers';
import type { ActionEvent, ActionLog, ActionType, ActorRef, CoverageEffect, FrozenLedgerRow, FrozenNeed, Role } from './types';

/**
 * Brief "Notification and Safety Constraints": "Log every offer: who was
 * considered, who was excluded and why, who approved, and the outcome."
 * Built only from the action log (the ledger snapshot frozen at proposal), so
 * it is reproducible later even if the dataset gains events or decide changes.
 */

export interface AuditTrail {
  readonly offerId: string;
  readonly physicianId: string;
  readonly name: string;
  readonly slotId: string;
  readonly needs: readonly FrozenNeed[];
  readonly window: { readonly startMs: EpochMs; readonly endMs: EpochMs };
  readonly routingScope: readonly string[];
  readonly seededConsultCount: number;
  readonly considered: readonly FrozenLedgerRow[];
  readonly excluded: readonly { readonly physicianId: string; readonly failedRules: readonly string[]; readonly why: readonly string[] }[];
  readonly proposed: { readonly by: ActorRef; readonly atMs: EpochMs };
  readonly approved: { readonly by: ActorRef; readonly atMs: EpochMs; readonly note: string | null } | null;
  readonly rejected: { readonly by: ActorRef; readonly atMs: EpochMs; readonly reason: string } | null;
  readonly sentAtMs: EpochMs | null;
  readonly channel: string;
  readonly messageText: string;
  readonly outcome: { readonly status: OfferStatus; readonly atMs: EpochMs | null; readonly by: ActorRef | null; readonly detail: string };
  readonly coverageEffect: CoverageEffect | null;
  readonly cancellationsCaused: readonly { readonly offerId: string; readonly type: 'offer_cancelled' | 'offer_superseded'; readonly atMs: EpochMs; readonly reason: string }[];
}

const asOf = (log: ActionLog, nowMs?: EpochMs) => nowMs ?? log.at(-1)?.atMs ?? 0;

export function auditTrail(log: ActionLog, offerId: string, nowMs?: EpochMs): AuditTrail | null {
  const at = asOf(log, nowMs);
  const r = foldOffers(log, at).find((x) => x.offerId === offerId);
  return r === undefined ? null : trailOf(log, r, at);
}

function trailOf(log: ActionLog, r: OfferRecord, at: EpochMs): AuditTrail {
  const p = r.proposal;
  const status = statusOf(r, at);
  const accepted = r.outcome?.event.type === 'offer_accepted' ? r.outcome.event.payload : null;
  const caused = log.flatMap((e) =>
    (e.type === 'offer_cancelled' && e.payload.filledBy === r.offerId) || (e.type === 'offer_superseded' && e.payload.wonBy === r.offerId)
      ? [{ offerId: e.payload.offerId, type: e.type, atMs: e.atMs, reason: e.payload.reason }]
      : [],
  );
  return {
    offerId: r.offerId,
    physicianId: p.physicianId,
    name: p.name,
    slotId: p.slotId,
    needs: p.needs,
    window: { startMs: p.window.startMs, endMs: p.window.endMs },
    routingScope: p.routingScope,
    seededConsultCount: p.seededConsultCount,
    considered: p.ledger,
    excluded: p.ledger.filter((x) => !x.eligible).map((x) => ({ physicianId: x.physicianId, failedRules: x.failedRules, why: x.rules.filter((y) => y.pass === false).map((y) => `${y.rule}: ${y.detail}`) })),
    proposed: { by: r.proposed.by, atMs: r.proposed.atMs },
    approved: r.approved === null ? null : { by: r.approved.by, atMs: r.approved.atMs, note: r.approved.note },
    rejected: r.rejected === null ? null : { by: r.rejected.by, atMs: r.rejected.atMs, reason: r.rejected.reason },
    sentAtMs: r.sent?.atMs ?? null,
    channel: p.channel,
    messageText: r.sent?.message ?? p.message,
    outcome: outcomeOf(r, status),
    coverageEffect: accepted?.coverageEffect ?? null,
    cancellationsCaused: caused,
  };
}

function outcomeOf(r: OfferRecord, status: OfferStatus): AuditTrail['outcome'] {
  const o = r.outcome;
  if (o !== null) {
    const e = o.event;
    const detail =
      e.type === 'offer_cancelled' || e.type === 'offer_superseded'
        ? e.payload.reason
        : e.type === 'offer_accepted'
          ? `online from ${fmt(e.payload.effectiveStartMs)} until ${fmt(e.payload.endMs)} ET`
          : e.type === 'offer_expired'
            ? `expired at ${fmt(e.payload.expiredAtMs)} ET`
            : status;
    return { status, atMs: e.type === 'offer_expired' ? e.payload.expiredAtMs : o.atMs, by: o.by, detail };
  }
  if (r.rejected !== null) return { status, atMs: r.rejected.atMs, by: r.rejected.by, detail: r.rejected.reason };
  if (status === 'expired' && r.delivered !== null) return { status, atMs: expiresAt(r.delivered.atMs), by: null, detail: `expired at ${fmt(expiresAt(r.delivered.atMs))} ET (derived; not yet materialized by tick)` };
  return { status, atMs: null, by: null, detail: 'pending' };
}

const fmt = (ms: EpochMs) => DateTime.fromMillis(ms, { zone: ET_ZONE }).toFormat('HH:mm:ss');
const iso = (ms: EpochMs | null) => (ms === null ? '' : (DateTime.fromMillis(ms, { zone: ET_ZONE }).toISO({ suppressMilliseconds: true }) ?? ''));
const who = (a: ActorRef | null | undefined) => (a === null || a === undefined ? '' : `${a.role}:${a.id}`);

/** Stable export columns, one row per offer. */
export const AUDIT_CSV_COLUMNS = [
  'offer_id',
  'slot_id',
  'physician_id',
  'physician_name',
  'needs',
  'window_start',
  'window_end',
  'routing_scope',
  'seeded_consults',
  'considered',
  'eligible',
  'excluded',
  'proposed_by',
  'proposed_at',
  'approved_by',
  'approved_at',
  'rejected_by',
  'rejected_at',
  'reject_reason',
  'sent_at',
  'channel',
  'message',
  'outcome',
  'outcome_at',
  'outcome_by',
  'outcome_detail',
  'cancellations_caused',
] as const;

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function auditCsv(log: ActionLog, nowMs?: EpochMs): string {
  const at = asOf(log, nowMs);
  const rows = foldOffers(log, at).map((r) => {
    const t = trailOf(log, r, at);
    const cells: Record<(typeof AUDIT_CSV_COLUMNS)[number], string | number> = {
      offer_id: t.offerId,
      slot_id: t.slotId,
      physician_id: t.physicianId,
      physician_name: t.name,
      needs: t.needs.map((n) => `${n.kind} ${n.hospitalId}`).join('; '),
      window_start: iso(t.window.startMs),
      window_end: iso(t.window.endMs),
      routing_scope: t.routingScope.join(' '),
      seeded_consults: t.seededConsultCount,
      considered: t.considered.length,
      eligible: t.considered.filter((x) => x.eligible).map((x) => x.physicianId).join(' '),
      excluded: t.excluded.map((x) => `${x.physicianId}: ${x.failedRules.join(' + ')}`).join('; '),
      proposed_by: who(t.proposed.by),
      proposed_at: iso(t.proposed.atMs),
      approved_by: who(t.approved?.by),
      approved_at: iso(t.approved?.atMs ?? null),
      rejected_by: who(t.rejected?.by),
      rejected_at: iso(t.rejected?.atMs ?? null),
      reject_reason: t.rejected?.reason ?? '',
      sent_at: iso(t.sentAtMs),
      channel: t.channel,
      message: t.messageText.replace(/\n/g, ' / '),
      outcome: t.outcome.status,
      outcome_at: iso(t.outcome.atMs),
      outcome_by: who(t.outcome.by),
      outcome_detail: t.outcome.detail,
      cancellations_caused: t.cancellationsCaused.map((x) => `${x.offerId} ${x.type}`).join('; '),
    };
    return AUDIT_CSV_COLUMNS.map((c) => csvCell(cells[c])).join(',');
  });
  return [AUDIT_CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

// ---------------------------------------------------------------- every action (D-88)

/**
 * Brief "Problem to Solve" names three interventions (reassign a stranded
 * consult, escalate to clinical leadership, offer a split shift) and "Users
 * and Decision Rights" says who may take each step. auditTrail/auditCsv above
 * cover offers only; actionAuditRows covers every action in the log, one row
 * per action event, with who acted, in which role, and the approval state of
 * the intervention the event belongs to. Built from the action log alone.
 */

/**
 * n/a: no approval step exists for this action (reassignment is a coordinator
 * right; internal alerts are the brief's permitted low-risk automation).
 * awaiting/approved/rejected: split-shift offers ("Every offer is approved by
 * the clinical lead on duty before it is sent"). awaiting/authorized:
 * escalations (the clinical lead "authorize[s] escalations").
 */
export type ApprovalState = 'n/a' | 'awaiting' | 'approved' | 'rejected' | 'authorized';

export interface ActionAuditRow {
  readonly seq: number;
  readonly atMs: EpochMs;
  readonly type: ActionType;
  readonly actorRole: Role;
  readonly actorId: string;
  /** offerId | escalationId | consultId | alertId. */
  readonly subjectId: string;
  readonly physicianIds: readonly string[];
  readonly hospitalIds: readonly string[];
  readonly consultIds: readonly string[];
  readonly approvalState: ApprovalState;
  /** One plain-English line built from ids and the payload's own text; never a consult id or clinical term (PHI guard). */
  readonly detail: string;
}

/** Brief "Users and Decision Rights": "Reassign consults" is a coordinator right with no approval step. */
export const REASSIGNMENT_NO_APPROVAL_NOTE = 'coordinator right, no approval required (brief Users and Decision Rights)';

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function actionAuditRows(log: ActionLog, nowMs?: EpochMs): ActionAuditRow[] {
  const at = asOf(log, nowMs);
  const known = actionsKnownAt(log, at);
  const offers = new Map(foldOffers(log, at).map((r) => [r.offerId, r]));
  const authorized = new Set(known.flatMap((e) => (e.type === 'escalation_authorized' ? [e.payload.escalationId] : [])));
  return known.map((e) => actionRow(e, offers, authorized));
}

function offerApproval(r: OfferRecord | undefined): ApprovalState {
  if (r === undefined) return 'awaiting';
  return r.rejected !== null ? 'rejected' : r.approved !== null ? 'approved' : 'awaiting';
}

function actionRow(e: ActionEvent, offers: ReadonlyMap<string, OfferRecord>, authorized: ReadonlySet<string>): ActionAuditRow {
  const base = { seq: e.seq, atMs: e.atMs, type: e.type, actorRole: e.actor.role, actorId: e.actor.id };
  switch (e.type) {
    case 'escalation_raised': {
      const s = e.payload.subject;
      const consultIds = s.consultIds ?? [];
      const hospitalIds = s.hospitalIds ?? [];
      const about = [count(consultIds.length, 'consult'), hospitalIds.length > 0 ? `at ${hospitalIds.join(' ')}` : '', s.needId === undefined ? '' : `need ${s.needId}`, s.attentionItemId === undefined ? '' : `attention item ${s.attentionItemId}`].filter((x) => x !== '').join(' ');
      return {
        ...base,
        subjectId: e.payload.escalationId,
        physicianIds: [],
        hospitalIds,
        consultIds,
        approvalState: authorized.has(e.payload.escalationId) ? 'authorized' : 'awaiting',
        detail: `escalation ${e.payload.escalationId} raised to the clinical lead about ${about}: ${e.payload.reason}`,
      };
    }
    case 'escalation_authorized':
      return { ...base, subjectId: e.payload.escalationId, physicianIds: [], hospitalIds: [], consultIds: [], approvalState: 'authorized', detail: `escalation ${e.payload.escalationId} authorized by the clinical lead${e.payload.note === null ? '' : `: ${e.payload.note}`}` };
    case 'reassignment_requested': {
      const p = e.payload;
      return {
        ...base,
        subjectId: p.consultId,
        physicianIds: p.fromPhysicianId === null ? [p.toPhysicianId] : [p.fromPhysicianId, p.toPhysicianId],
        hospitalIds: [p.hospitalId],
        consultIds: [p.consultId],
        approvalState: 'n/a',
        detail: `reassignment of 1 consult at ${p.hospitalId} ${p.fromPhysicianId === null ? 'from nobody' : `from ${p.fromPhysicianId}`} to ${p.toPhysicianId} ${p.label} (${REASSIGNMENT_NO_APPROVAL_NOTE}); ${p.toPhysicianId}: ${p.why}`,
      };
    }
    case 'internal_alert_sent':
      return {
        ...base,
        subjectId: e.payload.alertId,
        physicianIds: e.payload.physicianIds,
        hospitalIds: [],
        consultIds: [],
        approvalState: 'n/a',
        detail: `internal alert ${e.payload.alertId}${e.payload.automated ? ' (automated, low-risk step)' : ''}${e.payload.physicianIds.length === 0 ? '' : ` about ${e.payload.physicianIds.join(' ')}`}: ${e.payload.message}`,
      };
    default:
      if (e.type.startsWith('standby_')) return standbyRow(e as StandbyEvent, base);
      return offerRow(e as OfferEvent, base, offers.get((e as OfferEvent).payload.offerId));
  }
}

type StandbyEvent = Extract<ActionEvent, { payload: { standbyId: string } }>;
type OfferEvent = Exclude<ActionEvent, { type: 'escalation_raised' | 'escalation_authorized' | 'reassignment_requested' | 'internal_alert_sent' } | StandbyEvent>;

/** Standby network events (Phase 4): the pre-alert and the activation each carry the brief's approval step; the rest are state. */
function standbyRow(e: StandbyEvent, base: Pick<ActionAuditRow, 'seq' | 'atMs' | 'type' | 'actorRole' | 'actorId'>): ActionAuditRow {
  const id = e.payload.standbyId;
  const p = e.type === 'standby_proposed' ? e.payload : null;
  const approval: ApprovalState =
    e.type === 'standby_proposed' || e.type === 'standby_activation_proposed'
      ? 'awaiting'
      : e.type === 'standby_rejected' || e.type === 'standby_activation_rejected'
        ? 'rejected'
        : e.type === 'standby_approved' || e.type === 'standby_activation_approved' || e.type === 'standby_prealert_sent' || e.type === 'standby_prealert_delivered' || e.type === 'standby_activation_sent' || e.type === 'standby_activation_delivered'
          ? 'approved'
          : 'n/a';
  const detail =
    e.type === 'standby_proposed' && p !== null
      ? `standby pre-alert ${id} to ${p.physicianId} proposed for ${fmt(p.window.startMs)}-${fmt(p.window.endMs)} ET at ${p.coveredHospitalIds.join(' ')}; ${count(p.candidates.filter((x) => x.eligible).length, 'eligible candidate')} of ${count(p.candidates.length, 'physician')} considered`
      : e.type === 'standby_activation_proposed'
        ? `activation of standby ${id} proposed: log on by ${fmt(e.payload.logOnByMs)} ET to cover ${e.payload.scopeHospitalIds.join(' ')} until ${fmt(e.payload.endMs)} ET, seeded at ${e.payload.seededConsultCount} (${e.payload.trigger.kind})`
        : e.type === 'standby_activated'
          ? `standby ${id} activated: online ${fmt(e.payload.effectiveStartMs)}-${fmt(e.payload.endMs)} ET at ${e.payload.scopeHospitalIds.join(' ')}`
          : e.type === 'standby_released'
            ? `standby ${id} released: ${e.payload.reason}`
            : e.type === 'standby_cancelled' || e.type === 'standby_rejected' || e.type === 'standby_activation_rejected'
              ? `standby ${id} ${e.type.slice('standby_'.length).replace(/_/g, ' ')}: ${e.payload.reason}`
              : e.type === 'standby_expired'
                ? `standby ${id} ${e.payload.stage} expired at ${fmt(e.payload.expiredAtMs)} ET`
                : `standby ${id} ${e.type.slice('standby_'.length).replace(/_/g, ' ')}`;
  return {
    ...base,
    subjectId: id,
    physicianIds: p === null ? [] : [p.physicianId],
    hospitalIds: p?.coveredHospitalIds ?? ('scopeHospitalIds' in e.payload ? e.payload.scopeHospitalIds : []),
    consultIds: [],
    approvalState: approval,
    detail,
  };
}

function offerRow(e: OfferEvent, base: Pick<ActionAuditRow, 'seq' | 'atMs' | 'type' | 'actorRole' | 'actorId'>, r: OfferRecord | undefined): ActionAuditRow {
  const p = e.type === 'offer_proposed' ? e.payload : r?.proposal;
  const id = e.payload.offerId;
  const who = p?.physicianId ?? 'unknown physician';
  return {
    ...base,
    subjectId: id,
    physicianIds: p === undefined ? [] : [p.physicianId],
    hospitalIds: p?.routingScope ?? [],
    consultIds: [],
    approvalState: offerApproval(r),
    detail: offerDetail(e, who),
  };
}

function offerDetail(e: OfferEvent, who: string): string {
  const id = e.payload.offerId;
  switch (e.type) {
    case 'offer_proposed': {
      const q = e.payload;
      return `split-shift offer ${id} to ${who} proposed for ${fmt(q.window.startMs)}-${fmt(q.window.endMs)} ET at ${q.routingScope.join(' ')}, seeded at ${q.seededConsultCount}; ${count(q.ledger.filter((x) => x.eligible).length, 'eligible')} of ${count(q.ledger.length, 'physician')} considered`;
    }
    case 'offer_approved':
      return `offer ${id} to ${who} approved by the clinical lead${e.payload.note === null ? '' : `: ${e.payload.note}`}`;
    case 'offer_rejected':
      return `offer ${id} to ${who} rejected by the clinical lead: ${e.payload.reason}`;
    case 'offer_sent':
      return `offer ${id} sent to ${who} via ${e.payload.channel} (simulated delivery)`;
    case 'offer_delivered':
      return `offer ${id} delivered to ${who} via ${e.payload.channel}; expires ${fmt(e.payload.expiresAtMs)} ET`;
    case 'offer_accepted':
      return `offer ${id} accepted by ${who}: online from ${fmt(e.payload.effectiveStartMs)} until ${fmt(e.payload.endMs)} ET; ${count(e.payload.coverageEffect.filledNeedIds.length, 'need')} filled`;
    case 'offer_declined':
      return `offer ${id} declined by ${who}`;
    case 'offer_expired':
      return `offer ${id} to ${who} expired unanswered at ${fmt(e.payload.expiredAtMs)} ET`;
    case 'offer_cancelled':
      return `offer ${id} to ${who} cancelled (${e.payload.cause === 'gap_filled' ? `gap filled by ${e.payload.filledBy ?? 'another offer'}` : 'manual'}): ${e.payload.reason}`;
    case 'offer_superseded':
      return `offer ${id} to ${who} superseded in slot ${e.payload.slotId} by ${e.payload.wonBy}: ${e.payload.reason}`;
  }
}

/** Stable export columns, one row per action event (D-88). */
export const ACTION_CSV_COLUMNS = ['seq', 'at', 'type', 'actor_role', 'actor_id', 'subject_id', 'physician_ids', 'hospital_ids', 'consult_ids', 'approval_state', 'detail'] as const;

export function actionsCsv(log: ActionLog, nowMs?: EpochMs): string {
  const rows = actionAuditRows(log, nowMs).map((r) => {
    const cells: Record<(typeof ACTION_CSV_COLUMNS)[number], string | number> = {
      seq: r.seq,
      at: iso(r.atMs),
      type: r.type,
      actor_role: r.actorRole,
      actor_id: r.actorId,
      subject_id: r.subjectId,
      physician_ids: r.physicianIds.join(' '),
      hospital_ids: r.hospitalIds.join(' '),
      consult_ids: r.consultIds.join(' '),
      approval_state: r.approvalState,
      detail: r.detail.replace(/\n/g, ' / '),
    };
    return ACTION_CSV_COLUMNS.map((c) => csvCell(cells[c])).join(',');
  });
  return [ACTION_CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}
