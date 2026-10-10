import { DateTime } from 'luxon';
import { ET_ZONE } from '../time';
import type { EpochMs } from '../types';
import { expiresAt, foldOffers, statusOf, type OfferRecord, type OfferStatus } from './offers';
import type { ActionLog, ActorRef, CoverageEffect, FrozenLedgerRow, FrozenNeed } from './types';

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
