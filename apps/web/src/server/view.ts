import 'server-only';
import { QUIET_FEED_BANNER_MS, decideWithLog, headSeq, recommendNext, type AttentionItem, type DecisionReport, type EventRef, type Intervention, type NetworkState, type PhysicianFlag, type StandardEvaluation } from '@lookahead/engine';
import type { AttentionDTO, ConsultRowDTO, EvidenceDTO, FlagDTO, InjectSampleDTO, OfferContextDTO, PhysicianRowDTO, RecommendationDTO, RecommendedOfferDTO, ViewDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import { buildGrid } from './grid';
import { integritySummary } from './integrity';
import { ledgerRow } from './ledger';
import { acceptedWhatIf, escalationDTOs, offerDTOs, proposalContext, reassignmentDTOs, recommendedWhatIf, trapDTO } from './offers';
import type { StoreSnapshot } from './store';

/**
 * GET /api/view: one engine pass (decideWithLog: replay -> detect -> decide
 * with the action log's offers, D-54) reshaped for the Command Center.
 * Memoized on (nowMs, version) so many SSE clients share one computation.
 * No rule is evaluated here; every number and sentence is engine output.
 */

const MEMO_SIZE = 4;
const memo: { key: string; view: ViewDTO }[] = [];

export function computeView(s: StoreSnapshot): ViewDTO {
  const key = `${s.bootId}|${s.version}|${s.clock.nowMs}`;
  const hit = memo.find((m) => m.key === key);
  if (hit !== undefined) return hit.view;
  const view = buildView(s);
  memo.unshift({ key, view });
  memo.length = Math.min(memo.length, MEMO_SIZE);
  return view;
}

/** Test hook: how many views are memoized (proves the cache is shared). */
export const memoSize = (): number => memo.length;

function buildView(s: StoreSnapshot): ViewDTO {
  const nowMs = s.clock.nowMs;
  const d = decideWithLog({ dataset: s.dataset }, s.log, nowMs);
  const det = d.detection;
  const hospitalName = (id: string) => det.staffing.hospitalNames.get(id) ?? id;
  const attention = det.attention.map(attentionDTO);
  const offers = offerDTOs(s.log, nowMs);
  const recommendedOffer = recommendedOfferDTO(d, hospitalName);
  const lastEventAtMs = lastIngested(s, nowMs);
  return {
    bootId: s.bootId,
    dataset: {
      key: s.datasetMeta.key,
      label: s.datasetMeta.label,
      source: s.datasetMeta.source,
      snapshotLabel: s.datasetMeta.snapshotLabel,
      eventCount: s.dataset.events.length,
      previousLabel: s.previousMeta?.label ?? null,
      store: s.storeKind,
    },
    version: s.version,
    logSeq: headSeq(s.log),
    clock: { nowMs, mode: s.clock.mode, speed: s.clock.speed, snapshotMs: s.snapshotMs, scenarioDate: det.state.scenarioDate },
    lastEventAtMs,
    // OQ-46: a normal gap between events is not a stale feed.
    ...(lastEventAtMs !== null && nowMs - lastEventAtMs > QUIET_FEED_BANNER_MS ? { noNewEventsSince: lastEventAtMs } : {}),
    integrity: integritySummary(s),
    attention,
    coverage: buildGrid(d),
    demand: det.demand
      .filter((x) => x.spike)
      .map((x) => ({ hospitalId: x.hospitalId, hospitalName: x.hospitalName, count: x.count, p90: x.p90, mean: x.mean, baselineHourEt: x.baselineHourEt, contributingConsultIds: x.contributingConsultIds })),
    needs: d.needs,
    recommendation: recommendationDTO(d),
    ledger: d.ledger.map(ledgerRow),
    recommendedOffer,
    offerContext: offerContext(s, d, offers, recommendedOffer),
    offers,
    nextOffer: nextOfferDTO(s, d, offers),
    escalations: escalationDTOs(s.log, nowMs, (id) => det.attention.find((a) => a.id === id)?.headline ?? null),
    reassignments: reassignmentDTOs(s.log, nowMs),
    physicians: physicianRows(det.state),
    consults: consultRows(det.state, det.standards, nowMs),
    sample: injectSample(s, d),
  };
}

const evidence = (r: EventRef): EvidenceDTO => ({ eventId: r.eventId, eventType: r.eventType, eventTimeMs: r.eventTimeMs });

function attentionDTO(a: AttentionItem, i: number): AttentionDTO {
  return {
    rank: i + 1,
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    strokeAtRisk: a.strokeAtRisk,
    headline: a.headline,
    timeToImpactMs: a.timeToImpactMs,
    score: a.score,
    scoreBreakdown: a.scoreBreakdown,
    why: a.why,
    because: a.because.map(evidence),
    consultIds: a.consultIds,
    hospitalIds: a.hospitalIds,
    physicianIds: a.physicianIds,
  };
}

function recommendationDTO(d: DecisionReport): RecommendationDTO | null {
  const r = d.recommendation;
  if (r === null) return null;
  return {
    attentionItemId: r.attentionItemId,
    headline: r.headline,
    rationale: r.rationale,
    steps: r.actions.map((x: Intervention) => ({
      kind: x.kind,
      summary: x.expectedEffect,
      detail: x.why,
      proposer: x.proposer,
      approver: x.approver,
      acceptor: x.acceptor,
      candidates: x.candidates.map((c) => ({ physicianId: c.physicianId, why: c.why })),
      physicianIds: x.targets.physicianIds,
      hospitalIds: x.targets.hospitalIds,
      consultIds: x.targets.consultIds,
    })),
  };
}

function recommendedOfferDTO(d: DecisionReport, hospitalName: (id: string) => string): RecommendedOfferDTO | null {
  const o = d.recommendedOffer;
  if (o === null) return null;
  const w = o.window;
  return {
    physicianId: o.physicianId,
    name: o.name,
    window: { startMs: w.startMs, endMs: w.endMs, minutesToOnline: w.minutesToOnline, effectiveMinutes: w.effectiveMinutes, bindingCap: w.bindingCap },
    routingScope: o.routingScope,
    scopeNames: o.routingScope.map(hospitalName),
    seededConsultCount: o.seededConsultCount,
    value: o.value,
    coversNeeds: o.coversNeeds,
    why: o.why,
    message: o.message,
    trap: trapDTO(o.trap, o.name),
    whatIf: recommendedWhatIf(d),
  };
}

/** TRAP / WHAT-IF tabs: the most recent live or accepted offer, else the recommendation. */
function offerContext(s: StoreSnapshot, d: DecisionReport, offers: ViewDTO['offers'], rec: RecommendedOfferDTO | null): OfferContextDTO {
  const live = [...offers].reverse().find((o) => ['proposed', 'approved', 'sent', 'delivered', 'accepted'].includes(o.status));
  if (live !== undefined) {
    const ctx = proposalContext(s, live);
    const names = new Map(d.detection.staffing.hospitalNames);
    const whatIf = live.status === 'accepted' && live.coverageEffect !== null ? acceptedWhatIf(live, live.coverageEffect, names) : ctx.whatIf;
    return { source: whatIf.source, offerId: live.offerId, trap: ctx.trap, whatIf };
  }
  if (rec !== null) return { source: 'recommended', offerId: null, trap: rec.trap, whatIf: rec.whatIf };
  return { source: 'none', offerId: null, trap: null, whatIf: recommendedWhatIf(d) };
}

/**
 * OQ-37/OQ-43: after a decline, an expiry or a rejection the engine's
 * recommendNext skips that physician for overlapping needs; with nobody left
 * the escalation stays with the clinical lead.
 */
function nextOfferDTO(s: StoreSnapshot, d: DecisionReport, offers: ViewDTO['offers']): ViewDTO['nextOffer'] {
  const spent = offers.filter((o) => ['declined', 'expired', 'rejected'].includes(o.status)).map((o) => ({ offerId: o.offerId, physicianId: o.physicianId, name: o.name, status: o.status }));
  if (spent.length === 0) return { physicianId: d.recommendedOffer?.physicianId ?? null, name: d.recommendedOffer?.name ?? null, why: [], spent, escalationSuggested: false };
  const next = recommendNext({ dataset: s.dataset }, s.log, s.clock.nowMs);
  const name = next.physicianId === null ? null : (d.ledger.find((e) => e.physicianId === next.physicianId)?.name ?? null);
  return { physicianId: next.physicianId, name, why: next.why, spent, escalationSuggested: next.physicianId === null };
}

// ------------------------------------------------------------------ /state rows

const FLAG_LABELS: Readonly<Record<string, string>> = {
  EXTERNAL_VIDEO_SUSPECTED: 'EXTERNAL VIDEO?',
  AGENT_OFFLINE_UNVERIFIED: 'AGENT OFFLINE',
  TEMP_UNAVAILABLE_WITH_ASSIGNED: 'UNAVAILABLE + ASSIGNED',
  RINGING_UNANSWERED: 'RINGING',
  IN_MEETING_INTERRUPTIBLE: 'IN MEETING',
};

function flagDTO(f: PhysicianFlag): FlagDTO {
  const v = f.value;
  const since = etHm(v.sinceMs);
  const detail =
    v.code === 'EXTERNAL_VIDEO_SUSPECTED'
      ? `Camera active since ${since} with no Synapse video and status not In Meeting: treated as busy (brief "Availability is inferred").`
      : v.code === 'AGENT_OFFLINE_UNVERIFIED'
        ? `Presence agent offline since ${since}: routing assumes available, unverified.`
        : v.code === 'TEMP_UNAVAILABLE_WITH_ASSIGNED'
          ? `Temporarily Unavailable since ${since} with ${v.consultIds.join(', ')} still assigned.`
          : v.code === 'RINGING_UNANSWERED'
            ? `Phone ringing ${v.seconds} s${v.consultId === null ? '' : ` for ${v.consultId}`}, unanswered.`
            : `In Meeting since ${since}${v.cameraActive ? ' with camera active' : ''}: interruptible.`;
  return { code: v.code, label: FLAG_LABELS[v.code] ?? v.code, sinceMs: v.sinceMs, detail, because: f.because.map(evidence) };
}

function physicianRows(state: NetworkState): PhysicianRowDTO[] {
  return Object.values(state.physicians)
    .filter((p) => p.onRoster)
    .sort((a, b) => (a.physicianId < b.physicianId ? -1 : 1))
    .map((p) => ({
      physicianId: p.physicianId,
      name: p.name ?? p.physicianId,
      shift: p.shift === null ? '' : `${etHm(p.shift.startMs)}-${etHm(p.shift.endMs)}`,
      selfReported: p.selfStatus.value ?? '-',
      agent: p.agent.online ? 'Online' : 'Offline',
      derivedState: p.derivedState.value,
      derivedBecause: p.derivedState.because.map(evidence),
      consults: p.consultsThisShift,
      calls: p.callsThisShift,
      open: p.openConsultIds.length,
      minToEnd: p.shift === null ? '-' : String(Math.floor((p.shift.endMs - state.asOfMs) / 60_000)),
      openConsultIds: p.openConsultIds,
      flags: p.flags.map(flagDTO),
    }));
}

const LEVEL_RANK = { ok: 0, warning: 1, critical: 2 } as const;

function consultRows(state: NetworkState, standards: readonly StandardEvaluation[], nowMs: number): ConsultRowDTO[] {
  return Object.values(state.consults)
    .filter((c) => c.open)
    .sort((a, b) => (a.consultId < b.consultId ? -1 : 1))
    .map((c) => {
      const worst = standards
        .filter((x) => x.consultId === c.consultId)
        .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.criticalAtMs - b.criticalAtMs)[0];
      return {
        consultId: c.consultId,
        hospitalId: c.hospitalId ?? '-',
        hospitalName: c.hospitalName ?? '-',
        type: c.consultType ?? '-',
        stage: c.stage ?? '-',
        enteredMs: c.stageEnteredMs,
        minInStage: c.stageEnteredMs === null ? null : Math.floor((nowMs - c.stageEnteredMs) / 60_000),
        minSinceReceived: c.receivedMs === null ? null : Math.floor((nowMs - c.receivedMs) / 60_000),
        assigned: c.assignedPhysicianId,
        standard:
          worst === undefined
            ? null
            : { label: worst.label, level: worst.level, elapsedMin: Math.round(worst.elapsedMs / 6_000) / 10, warnAtMs: worst.warnAtMs, criticalAtMs: worst.criticalAtMs },
      };
    });
}

// ------------------------------------------------------------------ misc

/** Latest ingested_at among Sevaro events known at now (the "no new events" banner). */
function lastIngested(s: StoreSnapshot, nowMs: number): number | null {
  let max: number | null = null;
  for (const e of s.dataset.events) if (e.ingestedAt <= nowMs && (max === null || e.ingestedAt > max)) max = e.ingestedAt;
  return max;
}

/** Next free id of the same shape as the largest one in use ("X-0099" -> "X-0100"). */
export function nextId(ids: Iterable<string>, fallbackPrefix: string): string {
  let best: { prefix: string; n: number; width: number } | null = null;
  for (const id of ids) {
    const m = /^(.*?)(\d+)$/.exec(id);
    if (m === null) continue;
    const n = Number(m[2]);
    if (best === null || n > best.n) best = { prefix: m[1] ?? '', n, width: (m[2] ?? '').length };
  }
  if (best === null) return `${fallbackPrefix}1`;
  return `${best.prefix}${String(best.n + 1).padStart(best.width, '0')}`;
}

/** /inject "Insert sample": the surging hospital comes from the engine's demand evaluation. */
function injectSample(s: StoreSnapshot, d: DecisionReport): InjectSampleDTO {
  const surge = [...d.detection.demand].filter((x) => x.spike).sort((a, b) => b.count - a.count)[0];
  const consultIds = s.dataset.events.flatMap((e) => (e.consultId === null ? [] : [e.consultId]));
  const eventIds = s.dataset.events.map((e) => e.eventId);
  const first = nextId(eventIds, 'EVT-');
  const second = nextId([...eventIds, first], 'EVT-');
  return { surgingHospitalId: surge?.hospitalId ?? null, surgingHospitalName: surge?.hospitalName ?? null, nextConsultId: nextId(consultIds, 'CON-'), nextEventIds: [first, second] };
}
