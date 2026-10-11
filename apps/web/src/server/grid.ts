import { coverageStatus, type DecisionReport, type HospitalCoverageAt, type Need, type ScheduledShift } from '@lookahead/engine';
import type { CellClass, CoverageCellDTO, CoverageGridDTO, CoverageRowDTO, ShiftMarkerDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';

/**
 * CENTER panel: hospitals x 15-min buckets over the decision projection
 * (brief "Project coverage forward at least 90 minutes, accounting for shift
 * ends and the demand baseline"). Each cell is the worst engine status among
 * the projection points inside the bucket (coverageStatus, OQ-29), upgraded
 * to DEADLOCK while a DEADLOCK_NOW need (OQ-32) overlaps it. Buckets start at
 * now and then follow quarter hours, so 19:00 and 20:00 shift changes fall on
 * bucket edges.
 */

export const BUCKET_MIN = 15;
const BUCKET_MS = BUCKET_MIN * 60_000;
const RANK: Record<CellClass, number> = { OK: 0, AT_RISK: 1, HARD_GAP: 2, DEADLOCK: 3 };

export function bucketEdges(nowMs: number, endMs: number): number[] {
  const edges = [nowMs];
  for (let t = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS + BUCKET_MS; t < endMs; t += BUCKET_MS) edges.push(t);
  edges.push(endMs);
  return edges;
}

const needEnd = (n: Need, horizonEndMs: number) => (n.endMs === 'beyond_horizon' ? horizonEndMs : n.endMs);

export function buildGrid(decision: DecisionReport, pGap?: ReadonlyMap<string, number>): CoverageGridDTO {
  const cov = decision.decisionCoverage;
  const det = decision.detection;
  const nowMs = decision.nowMs;
  const edges = bucketEdges(nowMs, cov.horizonEndMs);
  const buckets = edges.slice(0, -1).map((startMs, i) => ({ startMs, endMs: edges[i + 1] ?? cov.horizonEndMs }));
  // decide().whatIf.before: needs over the full decision projection with accepted offers staffed (OQ-31).
  const needs = decision.whatIf.before;

  const rows: CoverageRowDTO[] = det.staffing.hospitals.map((h) => {
    const cells = buckets.map((b): CoverageCellDTO => {
      const points = cov.timeline.filter((p) => p.tMs >= b.startMs && p.tMs < b.endMs);
      let worst: { at: HospitalCoverageAt; tMs: number; cls: CellClass } | null = null;
      for (const p of points) {
        const at = p.perHospital[h.hospitalId];
        if (at === undefined) continue;
        const cls = coverageStatus(at) as CellClass;
        if (worst === null || RANK[cls] > RANK[worst.cls]) worst = { at, tMs: p.tMs, cls };
      }
      const overlapping = needs.filter((n) => n.hospitalId === h.hospitalId && n.startMs < b.endMs && needEnd(n, cov.horizonEndMs) > b.startMs);
      const deadlock = overlapping.some((n) => n.kind === 'DEADLOCK_NOW');
      const at = worst?.at;
      return {
        startMs: b.startMs,
        endMs: b.endMs,
        atMs: worst?.tMs ?? b.startMs,
        required: at?.required ?? 0,
        staffedConfirmed: at?.staffedConfirmed ?? 0,
        staffedExpected: at?.staffedExpected ?? 0,
        class: deadlock ? 'DEADLOCK' : (worst?.cls ?? 'OK'),
        expectedIds: at?.expectedIds ?? [],
        staffedIds: at?.staffedIds ?? [],
        needIds: overlapping.map((n) => n.id),
        // Standby gap grid cells are quarter-hour aligned like these buckets (D-90 4.1); the first partial bucket has no cell.
        pGap: pGap?.get(`${h.hospitalId}|${b.startMs}`) ?? null,
      };
    });
    const worst = cells.reduce<CellClass>((w, c) => (RANK[c.class] > RANK[w] ? c.class : w), 'OK');
    return { hospitalId: h.hospitalId, hospitalName: h.hospitalName, worst, routableNow: cov.routableNow[h.hospitalId] ?? 0, cells };
  });

  // Non-OK hospitals first (worst class, then earliest issue), then the all-OK group.
  const firstIssue = (r: CoverageRowDTO) => r.cells.find((c) => c.class !== 'OK')?.startMs ?? Number.POSITIVE_INFINITY;
  rows.sort((a, b) => RANK[b.worst] - RANK[a.worst] || firstIssue(a) - firstIssue(b) || (a.hospitalId < b.hospitalId ? -1 : 1));

  return {
    nowMs,
    bucketMin: BUCKET_MIN,
    detectionHorizonEndMs: det.coverage.horizonEndMs,
    horizonEndMs: cov.horizonEndMs,
    buckets,
    rows,
    markers: shiftMarkers(det.staffing.shifts, nowMs, cov.horizonEndMs),
  };
}

/** Shift starts and ends inside the projection, grouped by instant ("19:00 −PHY-003, −PHY-006 / +PHY-011 (expected)"). */
export function shiftMarkers(shifts: readonly ScheduledShift[], nowMs: number, endMs: number): ShiftMarkerDTO[] {
  const at = new Map<number, { ends: ShiftMarkerDTO['ends'][number][]; starts: ShiftMarkerDTO['starts'][number][] }>();
  const slot = (t: number) => {
    const s = at.get(t) ?? { ends: [], starts: [] };
    at.set(t, s);
    return s;
  };
  for (const s of shifts) {
    if (s.endMs > nowMs && s.endMs <= endMs) slot(s.endMs).ends.push({ physicianId: s.physicianId, name: s.name });
    if (s.startMs > nowMs && s.startMs <= endMs) slot(s.startMs).starts.push({ physicianId: s.physicianId, name: s.name, confirmation: s.confirmation, source: s.source });
  }
  const byId = (a: { physicianId: string }, b: { physicianId: string }) => (a.physicianId < b.physicianId ? -1 : 1);
  return [...at.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, s]) => {
      const ends = [...s.ends].sort(byId);
      const starts = [...s.starts].sort(byId);
      const label = [ends.map((x) => `−${x.physicianId}`).join(', '), starts.map(startLabel).join(', ')].filter((x) => x !== '').join(' / ');
      return { atMs: t, ends, starts, label: `${etHm(t)} ${label}` };
    });
}

function startLabel(x: ShiftMarkerDTO['starts'][number]): string {
  const tags = [x.source === 'split_shift_offer' ? 'offer' : null, x.confirmation === 'roster' ? null : x.confirmation].filter((t) => t !== null);
  return `+${x.physicianId}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
}
