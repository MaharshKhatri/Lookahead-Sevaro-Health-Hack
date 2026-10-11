import { describe, expect, it } from 'vitest';
import { REWIND_LATENCY_MIN, openerSummary, physicianDisplayName, rewind, type RewindReport } from '../src';
import { dataset } from './detect.helpers';
import { et } from './helpers';

/**
 * Sprint A1 (LOOKAHEAD-DEFINED opener): the single most impactful stroke
 * episode, read straight off the rewind report. Brief (Challenge 2): stroke
 * consults are time-critical; routing rule 5 logs routing_attempt_failed and
 * retries every 5 min. The opener never recomputes: every number must equal
 * the rewind's own line rows and first actions.
 */
const NOW = et('18:20:00');
const FROM = et('17:00:00');

function row(r: RewindReport, kind: 'actual' | 'reactive' | 'anticipatory', consultId: string) {
  return r.lines.find((l) => l.kind === kind)?.perConsult.find((c) => c.consultId === consultId);
}

describe('openerSummary', () => {
  const r = rewind(dataset, NOW, { fromMs: FROM });
  const o = openerSummary(r, dataset);

  it('picks an anticipatory episode whose numbers equal the rewind rows for that consult and its first actions', () => {
    expect(o).not.toBeNull();
    if (o === null) return;
    expect(o.kind).toBe('anticipatory');
    const a = row(r, 'actual', o.consultId);
    const b = row(r, 'reactive', o.consultId);
    const c = row(r, 'anticipatory', o.consultId);
    expect(a && b && c).toBeTruthy();
    expect(o.actualWaitMin).toBe(a?.minutesUnassigned);
    expect(o.reactiveWaitMin).toBe(b?.minutesUnassigned);
    expect(o.anticipatoryWaitMin).toBe(c?.minutesUnassigned);
    expect(o.strokeMinutesAverted).toBeCloseTo((a?.minutesUnassigned ?? 0) - (c?.minutesUnassigned ?? 0), 1);
    expect(o.strokeMinutesAverted).toBeGreaterThan(0);
    expect(o.hospitalId).toBe(a?.hospitalId);
    expect(o.actualGapOpenedMs).toBe(a?.receivedMs);
    expect(o.hospitalName).toBe(dataset.hospitals.find((h) => h.hospitalId === o.hospitalId)?.hospitalName);
    expect(o.standbyPhysicianId).toBe(r.firstActions?.physicianId);
    expect(o.preAlertTimeMs).toBe(r.firstActions?.preAlertAtMs);
    expect(o.activationTimeMs).toBe(r.firstActions?.activationRecommendedAtMs);
    expect(o.onlineTimeMs).toBe(r.firstActions?.onlineAtMs);
    expect(o.wouldHaveAssignedMs).toBe(c?.assignedMs);
    expect(o.coveredHospitalNames).toContain(o.hospitalName);
  });

  it('score = averted x (1 + routing_attempt_failed known by report.toMs) and is the maximum over stroke consults', () => {
    if (o === null) throw new Error('no opener');
    const known = dataset.events.filter((e) => e.ingestedAt <= r.toMs && e.eventType === 'routing_attempt_failed');
    const failures = (id: string) => new Set(known.filter((e) => e.consultId === id).map((e) => e.eventId)).size;
    expect(o.routingFailures).toBe(failures(o.consultId));
    expect(o.score).toBeCloseTo(o.strokeMinutesAverted * (1 + o.routingFailures), 1);
    const actual = r.lines[0]?.perConsult ?? [];
    for (const a of actual) {
      const c = row(r, 'anticipatory', a.consultId);
      const s = (a.minutesUnassigned - (c?.minutesUnassigned ?? a.minutesUnassigned)) * (1 + failures(a.consultId));
      expect(s).toBeLessThanOrEqual(o.score + 0.11);
    }
  });

  it('assumptions are exactly the report assumptions (REWIND_LATENCY_MIN)', () => {
    expect(o?.assumptions).toEqual(r.assumptions);
    expect(o?.assumptions).toMatchObject(REWIND_LATENCY_MIN);
  });

  it('display name is "Dr. <LastName>" from the roster', () => {
    if (o === null) throw new Error('no opener');
    const name = [...dataset.offShiftRoster, ...dataset.physiciansOnShift].find((p) => p.physicianId === o.standbyPhysicianId)?.name ?? '';
    expect(o.standbyPhysicianDisplayName).toBe(`Dr. ${name.split(/\s+/).at(-1) ?? ''}`);
    expect(physicianDisplayName(dataset, 'not-a-physician')).toBe('not-a-physician');
  });

  it('standby disabled: falls back to the biggest reactive win (kind reactive_only), matching the reactive row', () => {
    const off = rewind(dataset, NOW, { fromMs: et('18:10:00'), standbyEnabled: false });
    const f = openerSummary(off, dataset);
    const reactive = off.lines.find((l) => l.kind === 'reactive');
    const anyWin = (off.lines[0]?.perConsult ?? []).some((a, i) => (reactive?.perConsult[i]?.minutesUnassigned ?? a.minutesUnassigned) < a.minutesUnassigned);
    if (!anyWin) {
      expect(f).toBeNull();
      return;
    }
    expect(f?.kind).toBe('reactive_only');
    if (f === null) return;
    expect(f.preAlertTimeMs).toBeNull();
    expect(f.onlineTimeMs).toBe(reactive?.onlineAtMs);
    expect(f.anticipatoryWaitMin).toBe(f.actualWaitMin);
    expect(f.strokeMinutesAverted).toBeCloseTo(f.actualWaitMin - f.reactiveWaitMin, 1);
    expect(f.reactiveWaitMin).toBe(row(off, 'reactive', f.consultId)?.minutesUnassigned);
  });

  it('returns null when no line helps any consult', () => {
    const actual = r.lines[0];
    if (actual === undefined) throw new Error('no actual line');
    const flat: RewindReport = { ...r, lines: [actual, { ...actual, kind: 'reactive' }, { ...actual, kind: 'anticipatory' }] };
    expect(openerSummary(flat, dataset)).toBeNull();
  });
});
