import { DateTime } from 'luxon';
import type { DetectionReport } from '../detect';
import type { AcceptedOffer } from '../detect/staffing';
import { etClock } from '../detect/staffing';
import { MAX_OFFER_HOURS, NEED_VALUE_WEIGHTS, WEEKLY_OFFER_COUNT_SOURCE } from '../policy';
import { compareIds } from '../replay/derive';
import { ET_ZONE } from '../time';
import type { EpochMs, OffShiftPhysician } from '../types';
import { MAX_HOURS_7D, MAX_OFFERS_PER_WEEK, MAX_OPEN_OFFERS_PER_PHYSICIAN, MIN_OFFER_MINUTES, MIN_REST_HOURS } from './brief-rules';
import { needEndMs } from './needs';
import type { EligibilityRule, LedgerEntry, Need, OfferLogEntry, OfferWindow, ValueTerm, WindowCap } from './types';

/**
 * Split-shift eligibility ledger: brief "Coverage and Split-Shift
 * Eligibility" ("An off-shift physician may receive a split-shift offer only
 * if all of the following hold") plus the "Notification and Safety
 * Constraints" offer limits. Every off-shift roster physician is listed; none
 * is filtered silently. Each failure is attributed to its own rule: rule 6
 * sizes the window from the needs and MAX_OFFER_HOURS, rule 5 checks room
 * before the next scheduled shift, rule 4 checks the 60-h headroom.
 */

export interface LedgerContext {
  readonly detection: DetectionReport;
  readonly roster: readonly OffShiftPhysician[];
  readonly needs: readonly Need[];
  readonly decisionHorizonEndMs: EpochMs;
  readonly offerLog: readonly OfferLogEntry[];
  /** Accepted split-shift offers: scheduled shifts for rule 5 and hours for rule 4 (brief "Act"). */
  readonly acceptedOffers?: readonly AcceptedOffer[];
}

const HOUR = 3_600_000;
const MIN = 60_000;
const hrs = (ms: number) => (ms / HOUR).toFixed(1).replace(/\.0$/, '');
const dateTime = (ms: EpochMs) => DateTime.fromMillis(ms, { zone: ET_ZONE }).toFormat('MM-dd HH:mm');

export function buildLedger(ctx: LedgerContext): LedgerEntry[] {
  const entries = ctx.roster.map((r) => evaluatePhysician(ctx, r));
  const ranked = entries
    .filter((e) => e.eligible)
    .sort((a, b) => compareEligible(ctx, a, b))
    .map((e) => e.physicianId);
  return entries.map((e) => {
    const i = ranked.indexOf(e.physicianId);
    return i < 0 ? e : { ...e, rank: i + 1 };
  });
}

/** OQ-34: value desc, then shorter time to come online, then fewer declines in 30 days, then id. */
function compareEligible(ctx: LedgerContext, a: LedgerEntry, b: LedgerEntry): number {
  const ra = ctx.roster.find((r) => r.physicianId === a.physicianId);
  const rb = ctx.roster.find((r) => r.physicianId === b.physicianId);
  return (
    (b.value ?? 0) - (a.value ?? 0) ||
    (ra?.estMinutesToOnline ?? 0) - (rb?.estMinutesToOnline ?? 0) ||
    (ra?.offersDeclinedLast30d ?? 0) - (rb?.offersDeclinedLast30d ?? 0) ||
    compareIds(a.physicianId, b.physicianId)
  );
}

function evaluatePhysician(ctx: LedgerContext, r: OffShiftPhysician): LedgerEntry {
  const nowMs = ctx.detection.nowMs;
  const credentials = ctx.detection.staffing.credentials.get(r.physicianId) ?? new Set<string>();
  const covered = ctx.needs.filter((n) => n.qualifiesForOffers && credentials.has(n.hospitalId));
  const scope = [...new Set(covered.map((n) => n.hospitalId))].sort(compareIds);
  const startMs = nowMs + r.estMinutesToOnline * MIN;
  // Accepted split shifts are shifts "they are already scheduled for" (rule 5) and hours worked (rule 4, OQ-20).
  const booked = (ctx.acceptedOffers ?? []).filter((o) => o.physicianId === r.physicianId && o.endMs > nowMs);
  const bookedHours = booked.reduce((h, o) => h + (o.endMs - o.startMs) / HOUR, 0);
  const headroomMs = (MAX_HOURS_7D - r.hoursWorkedLast7d - bookedHours) * HOUR;
  const schedule = scheduleAfter(r, booked, startMs);
  const needsEnd = covered.length === 0 ? null : Math.max(...covered.map((n) => needEndMs(n, ctx.decisionHorizonEndMs)));
  const window = needsEnd === null ? null : offerWindow(nowMs, startMs, r, schedule, needsEnd, headroomMs, ctx.decisionHorizonEndMs);

  const rules: EligibilityRule[] = [
    optInRule(r),
    credentialRule(ctx, credentials, covered, scope),
    restRule(r, startMs),
    hoursRule(r, bookedHours, headroomMs, window),
    overlapRule(startMs, schedule),
    minLengthRule(r, nowMs, startMs, needsEnd),
    openOfferRule(ctx, r),
    weeklyOfferRule(ctx, r, nowMs),
  ];
  const eligible = rules.every((x) => x.pass === true);
  const valueTerms = window === null ? [] : value(ctx, scope, window);
  const total = valueTerms.reduce((a, t) => a + t.points, 0);
  return {
    physicianId: r.physicianId,
    name: r.name,
    eligible,
    rules,
    offerWindow: window,
    coversNeeds: covered.map((n) => n.id),
    scopeHospitalIds: scope,
    value: window === null ? null : Math.round(total * 10) / 10,
    valueTerms,
    rank: null,
    rankWhy: window === null ? [] : rankWhy(r, valueTerms, total),
  };
}

/** Window = [now + time to online, min(needs end, start + MAX_OFFER_HOURS, next scheduled shift, start + 60-h headroom)]. */
interface Schedule {
  /** Earliest scheduled start at/after the offered start (roster next shift or an accepted split shift). */
  readonly nextStartMs: EpochMs;
  readonly nextLabel: string;
  /** An accepted split shift that already contains the offered start. */
  readonly inside: AcceptedOffer | null;
}

function scheduleAfter(r: OffShiftPhysician, booked: readonly AcceptedOffer[], startMs: EpochMs): Schedule {
  const next = [{ atMs: r.nextShiftStart, label: `next scheduled shift ${dateTime(r.nextShiftStart)} ET` }, ...booked.map((o) => ({ atMs: o.startMs, label: `accepted split shift ${dateTime(o.startMs)} ET` }))]
    .filter((x) => x.atMs >= startMs)
    .sort((a, b) => a.atMs - b.atMs)[0] ?? { atMs: r.nextShiftStart, label: `next scheduled shift ${dateTime(r.nextShiftStart)} ET` };
  return { nextStartMs: next.atMs, nextLabel: next.label, inside: booked.find((o) => o.startMs <= startMs && startMs < o.endMs) ?? null };
}

function offerWindow(nowMs: EpochMs, startMs: EpochMs, r: OffShiftPhysician, schedule: Schedule, needsEnd: EpochMs, headroomMs: number, horizonEnd: EpochMs): OfferWindow {
  const caps: WindowCap[] = [
    { kind: 'needs_end', atMs: needsEnd, detail: needsEnd >= horizonEnd ? `covered needs persist past the decision projection (${etClock(horizonEnd)} ET, OQ-31)` : `covered needs end ${etClock(needsEnd)} ET` },
    { kind: 'max_offer_hours', atMs: startMs + MAX_OFFER_HOURS * HOUR, detail: `MAX_OFFER_HOURS ${MAX_OFFER_HOURS} h after start` },
    { kind: 'next_scheduled_shift', atMs: schedule.inside === null ? schedule.nextStartMs : startMs, detail: `${schedule.inside === null ? schedule.nextLabel : 'inside an accepted split shift'} (may end exactly then, OQ-21)` },
    { kind: 'hours_headroom', atMs: startMs + Math.max(0, headroomMs), detail: `${hrs(Math.max(0, headroomMs))} h of 60-h headroom` },
  ];
  const binding = caps.reduce((a, c) => (c.atMs < a.atMs ? c : a));
  const endMs = Math.max(startMs, binding.atMs);
  return {
    sentMs: nowMs,
    startMs,
    endMs,
    minutesToOnline: r.estMinutesToOnline,
    offeredMinutes: (endMs - nowMs) / MIN,
    effectiveMinutes: (endMs - startMs) / MIN,
    caps,
    bindingCap: binding.kind,
  };
}

function optInRule(r: OffShiftPhysician): EligibilityRule {
  return { rule: 'ELIG_OPT_IN', pass: r.splitShiftOptIn, detail: `split_shift_opt_in = ${r.splitShiftOptIn ? 'Yes' : 'No'}`, because: [] };
}

function credentialRule(ctx: LedgerContext, credentials: ReadonlySet<string>, covered: readonly Need[], scope: readonly string[]): EligibilityRule {
  const gapHospitals = [...new Set(ctx.needs.filter((n) => n.qualifiesForOffers).map((n) => n.hospitalId))].sort(compareIds);
  const advisoryOnly = [...new Set(ctx.needs.filter((n) => !n.qualifiesForOffers && credentials.has(n.hospitalId) && !scope.includes(n.hospitalId)).map((n) => n.hospitalId))].sort(compareIds);
  const creds = [...credentials].sort(compareIds).join(', ');
  const advisory = advisoryOnly.length > 0 ? `; ${advisoryOnly.join(', ')} AT_RISK only (advisory, OQ-30)` : '';
  if (scope.length === 0) {
    return { rule: 'ELIG_CREDENTIALED_AT_GAP', pass: false, detail: `credentialed at ${creds}; none is a gap hospital (${gapHospitals.join(', ') || 'none'})${advisory}`, because: [] };
  }
  const needs = covered.map((n) => `${n.kind} ${n.hospitalId} ${etClock(n.startMs)}-${n.endMs === 'beyond_horizon' ? 'beyond' : etClock(n.endMs)}`).join('; ');
  return { rule: 'ELIG_CREDENTIALED_AT_GAP', pass: true, detail: `credentialed at gap hospital(s) ${scope.join(', ')} (covers ${needs})${advisory}`, because: covered.flatMap((n) => n.because).slice(0, 6) };
}

function restRule(r: OffShiftPhysician, startMs: EpochMs): EligibilityRule {
  const rest = startMs - r.lastShiftEnd;
  const pass = rest >= MIN_REST_HOURS * HOUR;
  return { rule: 'ELIG_REST_10H', pass, detail: `last shift ended ${dateTime(r.lastShiftEnd)} ET; at offered start ${etClock(startMs)} ET: ${hrs(rest)} h ${pass ? '>=' : '<'} ${MIN_REST_HOURS} h`, because: [] };
}

function hoursRule(r: OffShiftPhysician, bookedHours: number, headroomMs: number, window: OfferWindow | null): EligibilityRule {
  const worked = r.hoursWorkedLast7d + bookedHours;
  const booked = bookedHours > 0 ? ` (${r.hoursWorkedLast7d} h + ${hrs(bookedHours * HOUR)} h accepted split shift)` : '';
  const pass = headroomMs >= MIN_OFFER_MINUTES * MIN;
  if (!pass) {
    return {
      rule: 'ELIG_HOURS_60',
      pass,
      detail: `${hrs(worked * HOUR)} h${booked} + minimum ${MIN_OFFER_MINUTES / 60} h offer = ${hrs((worked + MIN_OFFER_MINUTES / 60) * HOUR)} h > ${MAX_HOURS_7D} (headroom ${hrs(Math.max(0, headroomMs))} h)`,
      because: [],
    };
  }
  const offered = window === null ? null : (window.endMs - window.startMs) / HOUR;
  const detail =
    offered === null
      ? `${hrs(worked * HOUR)} h worked${booked}; headroom ${hrs(headroomMs)} h >= ${MIN_OFFER_MINUTES / 60} h`
      : `${hrs(worked * HOUR)} h${booked} + offered ${hrs(offered * HOUR)} h = ${hrs((worked + offered) * HOUR)} h <= ${MAX_HOURS_7D} (headroom ${hrs(headroomMs)} h before, ${hrs(headroomMs - offered * HOUR)} h after; OQ-20)`;
  return { rule: 'ELIG_HOURS_60', pass, detail, because: [] };
}

function overlapRule(startMs: EpochMs, schedule: Schedule): EligibilityRule {
  if (schedule.inside !== null) {
    const o = schedule.inside;
    return { rule: 'ELIG_NO_SCHEDULE_OVERLAP', pass: false, detail: `offered start ${etClock(startMs)} falls inside an accepted split shift ${etClock(o.startMs)}-${etClock(o.endMs)} ET`, because: [] };
  }
  const room = schedule.nextStartMs - startMs;
  const pass = room >= MIN_OFFER_MINUTES * MIN;
  const detail = pass
    ? `${schedule.nextLabel} starts ${hrs(room)} h after offered start ${etClock(startMs)}; a ${MIN_OFFER_MINUTES / 60}-h offer fits (may end exactly at shift start, OQ-21)`
    : `${schedule.nextLabel} starts ${Math.round(room / MIN)} min after offered start ${etClock(startMs)}; any ${MIN_OFFER_MINUTES / 60}-h offer would overlap it`;
  return { rule: 'ELIG_NO_SCHEDULE_OVERLAP', pass, detail, because: [] };
}

/** Rule 6 with OQ-08: (end - now) - minutes to online = end - start >= 120 min, sized by covered needs and MAX_OFFER_HOURS. */
function minLengthRule(r: OffShiftPhysician, nowMs: EpochMs, startMs: EpochMs, needsEnd: EpochMs | null): EligibilityRule {
  if (needsEnd === null) return { rule: 'ELIG_MIN_OFFER_2H', pass: null, detail: 'not applicable: no gap-hospital need to size an offer against', because: [] };
  const end = Math.min(needsEnd, startMs + MAX_OFFER_HOURS * HOUR);
  const offered = Math.round((end - nowMs) / MIN);
  const effective = Math.round((end - startMs) / MIN);
  const pass = effective >= MIN_OFFER_MINUTES;
  return {
    rule: 'ELIG_MIN_OFFER_2H',
    pass,
    detail: `offered ${etClock(nowMs)}-${etClock(end)} = ${offered} min, minus ${r.estMinutesToOnline} min to come online = ${effective} min ${pass ? '>=' : '<'} ${MIN_OFFER_MINUTES} (OQ-08)`,
    because: [],
  };
}

function openOfferRule(ctx: LedgerContext, r: OffShiftPhysician): EligibilityRule {
  const open = ctx.offerLog.filter((o) => o.physicianId === r.physicianId && o.status === 'open').length;
  return { rule: 'SAFETY_ONE_OPEN_OFFER', pass: open < MAX_OPEN_OFFERS_PER_PHYSICIAN, detail: `${open} open offer(s) in the offer log (max ${MAX_OPEN_OFFERS_PER_PHYSICIAN})`, because: [] };
}

/** OQ-09: the ISO week (Monday 00:00 ET) containing nowMs. */
export function isoWeekStartEt(nowMs: EpochMs): EpochMs {
  return DateTime.fromMillis(nowMs, { zone: ET_ZONE }).startOf('week').toMillis();
}

/** OQ-09: offers this ISO week (Monday 00:00 ET) from our own offer log. */
function weeklyOfferRule(ctx: LedgerContext, r: OffShiftPhysician, nowMs: EpochMs): EligibilityRule {
  const weekStart = isoWeekStartEt(nowMs);
  const sent = ctx.offerLog.filter((o) => o.physicianId === r.physicianId && o.sentMs >= weekStart && o.sentMs <= nowMs).length;
  return {
    rule: 'SAFETY_THREE_OFFERS_PER_WEEK',
    pass: sent < MAX_OFFERS_PER_WEEK,
    detail: `${sent} offer(s) since ${DateTime.fromMillis(weekStart, { zone: ET_ZONE }).toFormat('ccc MM-dd HH:mm')} ET (max ${MAX_OFFERS_PER_WEEK}; source ${WEEKLY_OFFER_COUNT_SOURCE})`,
    because: [],
  };
}

/** Need-minutes covered inside the window at scope hospitals, weighted by need kind (OQ-33). Time to online is already outside the window. */
function value(ctx: LedgerContext, scope: readonly string[], w: OfferWindow): ValueTerm[] {
  return ctx.needs
    .filter((n) => scope.includes(n.hospitalId))
    .map((n) => {
      const overlap = Math.max(0, Math.min(w.endMs, needEndMs(n, ctx.decisionHorizonEndMs)) - Math.max(w.startMs, n.startMs));
      const minutes = Math.round(overlap / MIN);
      const weight = NEED_VALUE_WEIGHTS[n.kind];
      return { needId: n.id, kind: n.kind, hospitalId: n.hospitalId, minutes, weight, points: minutes * weight };
    })
    .filter((t) => t.minutes > 0);
}

function rankWhy(r: OffShiftPhysician, terms: readonly ValueTerm[], total: number): string[] {
  const byKind = (['DEADLOCK_NOW', 'HARD_GAP', 'AT_RISK'] as const)
    .map((k) => [k, terms.filter((t) => t.kind === k).reduce((a, t) => a + t.points, 0)] as const)
    .filter(([, p]) => p > 0)
    .map(([k, p]) => `${k} ${p}`);
  return [
    `value ${Math.round(total * 10) / 10} = need-minutes x weight (${byKind.join(' + ') || 'none'}; weights DEADLOCK_NOW 3, HARD_GAP 2, AT_RISK 1, OQ-33)`,
    `${r.estMinutesToOnline} min to come online`,
    `${r.offersDeclinedLast30d} offer(s) declined in the last 30 days`,
  ];
}
