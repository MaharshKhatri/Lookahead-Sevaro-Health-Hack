import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEventText, decide, decideWithLog, detect, foldOffers, recommendNext, type ActContext, type AttentionItem, type Dataset, type DetectionReport } from '../src';
import { COORD, LEAD, delivered, must, run } from './act.helpers';
import { dataset } from './detect.helpers';
import { DATA_DIR, et } from './helpers';

/**
 * Injection torture suite: every scenario appends event_stream.csv rows through
 * appendEventText, exactly the path POST /api/events uses (brief "What Teams
 * Must Demonstrate" #8: "Accept new events ... and update detection without a
 * restart"). Each scenario starts from the untouched reference dataset.
 * Test-only ids (CLAUDE.md rule 5): EVT-9xxxx, CON-9xxx.
 */

const DAY = '2026-03-17';
const iso = (hms: string) => `${DAY}T${hms}-04:00`;
const row = (id: string, eventHms: string, ingestHms: string, consultId: string, type: string, physicianId: string, hospitalId: string, description: string) =>
  `${id},${iso(eventHms)},${iso(ingestHms)},${consultId},${type},${physicianId},${hospitalId},${description}`;
const STROKE = 'Stroke consult request received';
const NEURO = 'General Neuro consult request received';

const inject = (text: string, nowHms: string, base: Dataset = dataset) => appendEventText(base, text, { nowMs: et(nowHms) });
const accepted = (text: string, nowHms: string, base: Dataset = dataset): Dataset => {
  const r = inject(text, nowHms, base);
  expect(r.rejected, 'rejected rows').toEqual([]);
  expect(r.duplicates, 'duplicate rows').toEqual([]);
  return r.dataset;
};
const itemsFor = (r: DetectionReport, consultId: string, kind?: AttentionItem['kind']) => r.attention.filter((a) => a.consultIds.includes(consultId) && (kind === undefined || a.kind === kind));
const firstPoint = (r: DetectionReport, hospitalId: string) => r.coverage.timeline[0]?.perHospital[hospitalId];
const credentialedAt = (physicianId: string) => dataset.credentials.find((c) => c.physicianId === physicianId)?.credentialedHospitalIds ?? [];

describe('injection scenarios (brief #8), one fresh dataset each', () => {
  it('1. brief "Coverage": another stroke consult at the surging hospital keeps the spike (6 > p90), +1 requirement, new ROUTING_DEADLOCK in the top 3, stable ids', () => {
    const before = detect(dataset, et('18:22:00'));
    const after = detect(accepted([row('EVT-90001', '18:21:00', '18:21:02', 'CON-9001', 'consult_received', '', 'SYN-005', STROKE), row('EVT-90002', '18:21:30', '18:21:32', 'CON-9001', 'consult_triaged', '', 'SYN-005', 'Consult triaged')].join('\n'), '18:21:40'), et('18:22:00'));
    const demand = (r: DetectionReport) => r.demand.find((d) => d.hospitalId === 'SYN-005');
    expect(demand(before)).toMatchObject({ count: 5, p90: 1, spike: true });
    expect(demand(after)).toMatchObject({ count: 6, p90: 1, spike: true });
    expect(demand(after)?.contributingConsultIds).toContain('CON-9001');
    // OQ-19: the spike adds one to the block minimum for the whole horizon; it was already +1 and stays +1.
    const point = firstPoint(after, 'SYN-005');
    expect(point?.spikeAdd).toBe(1);
    expect(point?.required).toBe((point?.blockMinimum ?? 0) + 1);
    expect(point?.required).toBe(firstPoint(before, 'SYN-005')?.required);
    const c = after.state.consults['CON-9001'];
    expect(c).toMatchObject({ stage: 'Triaged', assignedPhysicianId: null, open: true, consultType: 'Stroke', hospitalId: 'SYN-005' });
    // Routing rule 5: nobody is routable at SYN-005, so the new consult deadlocks too.
    expect(after.coverage.routableNow['SYN-005']).toBe(0);
    expect(after.deadlocks.map((d) => d.consultId)).toEqual([...before.deadlocks.map((d) => d.consultId), 'CON-9001'].sort());
    const deadlockItem = itemsFor(after, 'CON-9001', 'ROUTING_DEADLOCK');
    expect(deadlockItem).toHaveLength(1);
    expect(after.attention.slice(0, 3).map((a) => a.id)).toContain(deadlockItem[0]?.id);
    // Pre-existing items keep their ids (keyed by kind + entity, never by rank).
    const afterIds = new Set(after.attention.map((a) => a.id));
    for (const a of before.attention) expect(afterIds.has(a.id), a.headline).toBe(true);
    expect(after.attention.length).toBeGreaterThan(before.attention.length);
  });

  it('2. brief "Coverage" + "Operational Standards": a stroke consult at a quiet hospital (p90 >= 2) makes no spike; it appears in state and the triaged clock starts', () => {
    const before = detect(dataset, et('18:22:00'));
    // Computed from baseline_hourly_volume.csv: a weekday 18:00 row with p90 >= 2 whose hospital is quiet now (count 0).
    const quiet = dataset.baselineHourly.find((b) => b.dowType === 'weekday' && b.hourStartEt.raw === '18:00' && b.p90Consults >= 2 && before.demand.find((d) => d.hospitalId === b.hospitalId)?.count === 0);
    expect(quiet).toBeDefined();
    const h = quiet?.hospitalId ?? '';
    const after = detect(accepted([row('EVT-90011', '18:21:00', '18:21:02', 'CON-9011', 'consult_received', '', h, STROKE), row('EVT-90012', '18:21:20', '18:21:22', 'CON-9011', 'consult_triaged', '', h, 'Consult triaged')].join('\n'), '18:21:30'), et('18:22:00'));
    expect(after.demand.find((d) => d.hospitalId === h)).toMatchObject({ count: 1, spike: false, p90: quiet?.p90Consults });
    expect(after.demand.filter((d) => d.spike).map((d) => d.hospitalId)).toEqual(before.demand.filter((d) => d.spike).map((d) => d.hospitalId));
    expect(after.state.consults['CON-9011']).toMatchObject({ stage: 'Triaged', stageEnteredMs: et('18:21:20'), receivedMs: et('18:21:00'), consultType: 'Stroke', hospitalId: h });
    expect(after.standards.find((s) => s.consultId === 'CON-9011')).toMatchObject({ standard: 'TRIAGED_NOT_ASSIGNED', level: 'ok', clockStartMs: et('18:21:20'), warnAtMs: et('18:26:20'), criticalAtMs: et('18:31:20') });
    expect(firstPoint(after, h)?.spikeAdd).toBe(0);
  });

  it('3. brief "Operational Situations": a video_started that arrives 10 min late is applied at its event_time; derived state is video; listed as late (OQ-12)', () => {
    // CON-2110 (Stroke, Assigned to PHY-008, no call or video yet) gets a video start dated 18:10:00, ingested only now (18:20:00).
    const after = detect(accepted(row('EVT-90021', '18:10:00', '18:20:00', 'CON-2110', 'video_started', 'PHY-008', 'SYN-011', 'Video consult begins'), '18:20:00'), et('18:20:00'));
    const c = after.state.consults['CON-2110'];
    expect(c).toMatchObject({ stage: 'Video Consult In Progress', stageEnteredMs: et('18:10:00'), assignedPhysicianId: 'PHY-008' });
    expect(c?.stageHistory.at(-1)).toEqual({ stage: 'Video Consult In Progress', enteredMs: et('18:10:00'), eventId: 'EVT-90021' });
    const p = after.state.physicians['PHY-008'];
    // OQ-15 precedence: an active Synapse video outranks the self-reported Temporarily Unavailable.
    expect(p?.derivedState.value).toBe('Video Consult In Progress');
    expect(p?.activeVideo).toMatchObject({ consultId: 'CON-2110', startedMs: et('18:10:00'), eventId: 'EVT-90021' });
    expect(after.state.integrity.lateEvents.find((l) => l.eventId === 'EVT-90021')).toMatchObject({ eventType: 'video_started', eventTimeMs: et('18:10:00'), ingestedAtMs: et('18:20:00'), lagMs: 600_000 });
    // The assigned-not-contacted breach for CON-2110 is gone: the consult is past that stage.
    expect(after.standards.find((s) => s.consultId === 'CON-2110' && s.standard === 'ASSIGNED_NOT_CONTACTED')).toBeUndefined();
    // Not yet known one second before ingestion (D-20).
    expect(detect(accepted(row('EVT-90021', '18:10:00', '18:20:00', 'CON-2110', 'video_started', 'PHY-008', 'SYN-011', 'Video consult begins'), '18:20:00'), et('18:19:59')).state.consults['CON-2110']?.stage).toBe('Assigned');
  });

  it('4. OQ-04: re-sending the last row of event_stream.csv is a duplicate; nothing is accepted and detection is unchanged', () => {
    const last = readFileSync(join(DATA_DIR, 'event_stream.csv'), 'utf8').trim().split(/\r?\n/).at(-1) ?? '';
    expect(last.startsWith('EVT-01163,')).toBe(true);
    const r = inject(last, '18:21:00');
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.duplicates).toEqual([{ line: 1, eventId: 'EVT-01163', reason: 'same event_id and content as an existing event (OQ-04)' }]);
    expect(r.dataset.events).toHaveLength(dataset.events.length);
    expect(detect(r.dataset, et('18:21:00'))).toEqual(detect(dataset, et('18:21:00')));
  });

  it('5. OQ-29: shift_started for PHY-011 at 19:00 turns SYN-005 coverage from expected to confirmed supply', () => {
    const text = row('EVT-90031', '19:00:00', '19:00:01', '', 'shift_started', 'PHY-011', '', 'Shift started');
    const without = detect(dataset, et('19:00:05'));
    const withEvent = detect(accepted(text, '19:00:05'), et('19:00:05'));
    const w0 = firstPoint(without, 'SYN-005');
    const w1 = firstPoint(withEvent, 'SYN-005');
    expect(w0).toMatchObject({ staffedExpected: 1, expectedIds: ['PHY-011'] });
    expect(w1).toMatchObject({ staffedExpected: 0, expectedIds: [] });
    expect(w1?.staffedConfirmed).toBe((w0?.staffedConfirmed ?? 0) + 1);
    expect(w1?.staffed).toBe(w0?.staffed);
    expect(w1?.staffedIds).toContain('PHY-011');
    const arrival = (r: DetectionReport) => r.staffing.shifts.find((s) => s.source === 'scheduled_arrival' && s.physicianId === 'PHY-011');
    expect(arrival(without)?.confirmation).toBe('expected');
    expect(arrival(withEvent)).toMatchObject({ confirmation: 'confirmed', confirmedBy: { eventId: 'EVT-90031', eventTimeMs: et('19:00:00') } });
    // SYN-005 was AT_RISK (met only via the expected arrival); confirmed supply ends that classification at now.
    const atRiskNow = (r: DetectionReport) => r.coverage.classification.find((c) => c.hospitalId === 'SYN-005' && c.status === 'AT_RISK' && c.startMs === et('19:00:05'));
    expect(atRiskNow(without)).toBeDefined();
    expect(atRiskNow(withEvent)).toBeUndefined();
    // Knowledge time: at 19:00:00 the event (ingested 19:00:01) is not known yet.
    expect(arrival(detect(accepted(text, '19:00:05'), et('19:00:00')))?.confirmation).toBe('expected');
  });

  it('6. brief "Availability is inferred, not reported": self-reporting Available while on video keeps the derived video state; still not routable', () => {
    const before = detect(dataset, et('18:21:30'));
    expect(before.state.physicians['PHY-002']?.derivedState.value).toBe('Video Consult In Progress');
    const after = detect(accepted(row('EVT-90041', '18:21:00', '18:21:02', '', 'physician_status_changed', 'PHY-002', '', 'Self-reported status: Available'), '18:21:05'), et('18:21:30'));
    const p = after.state.physicians['PHY-002'];
    expect(p?.selfStatus).toMatchObject({ value: 'Available', because: [{ eventId: 'EVT-90041' }] });
    expect(p?.derivedState.value).toBe('Video Consult In Progress');
    expect(p?.activeVideo?.consultId).toBe(before.state.physicians['PHY-002']?.activeVideo?.consultId);
    for (const h of credentialedAt('PHY-002')) {
      const r = after.routability[h]?.['PHY-002'];
      expect(r?.routable, h).toBe(false);
      expect(r?.reasons.find((x) => x.rule === 'ROUTE_NOT_ON_VIDEO')?.pass, h).toBe(false);
      expect(r?.reasons.find((x) => x.rule === 'ROUTE_NOT_TEMP_UNAVAILABLE')?.pass, h).toBe(true);
    }
  });

  it('7. brief "Agent offline": agent_heartbeat_lost flags AGENT_OFFLINE_UNVERIFIED, routable unchanged but unverified, SIGNAL_CONFLICT raised', () => {
    const before = detect(dataset, et('18:21:30'));
    expect(before.state.physicians['PHY-004']?.agent.online).toBe(true);
    const after = detect(accepted(row('EVT-90051', '18:21:00', '18:21:02', '', 'agent_heartbeat_lost', 'PHY-004', '', 'Desktop agent heartbeat lost'), '18:21:05'), et('18:21:30'));
    const p = after.state.physicians['PHY-004'];
    expect(p?.agent).toMatchObject({ online: false, sinceMs: et('18:21:00') });
    expect(p?.camera.active).toBeNull(); // "offline means camera state is unknown"
    expect(p?.flags.map((f) => f.value.code)).toContain('AGENT_OFFLINE_UNVERIFIED');
    const hospitals = credentialedAt('PHY-004');
    expect(hospitals.length).toBeGreaterThan(0);
    for (const h of hospitals) {
      const b = before.routability[h]?.['PHY-004'];
      const a = after.routability[h]?.['PHY-004'];
      expect(a?.routable, h).toBe(b?.routable);
      expect(b?.verified, h).toBe(true);
      expect(a?.verified, h).toBe(false);
      expect(a?.reasons.find((x) => x.rule === 'ROUTE_AGENT_VERIFIED')).toMatchObject({ pass: false, affects: 'verified' });
    }
    expect(firstPoint(after, hospitals[0] ?? '')?.unverifiedIds).toContain('PHY-004');
    const item = after.attention.find((a) => a.kind === 'SIGNAL_CONFLICT' && a.physicianIds.includes('PHY-004'));
    expect(item?.headline).toContain('presence agent offline');
    expect(item?.because.map((e) => e.eventId)).toContain('EVT-90051');
    expect(before.attention.some((a) => a.kind === 'SIGNAL_CONFLICT' && a.physicianIds.includes('PHY-004'))).toBe(false);
  });

  it('8. brief "Camera active with no Synapse video session": EXTERNAL_VIDEO_SUSPECTED, derived "Camera Active - No Synapse Session", treated as busy', () => {
    const before = detect(dataset, et('18:21:30'));
    const p0 = before.state.physicians['PHY-004'];
    expect(p0).toMatchObject({ activeVideo: null, activeCalls: [] });
    expect(p0?.selfStatus.value).toBe('Available');
    const after = detect(accepted(row('EVT-90061', '18:21:00', '18:21:02', '', 'camera_active', 'PHY-004', '', 'Desktop agent: camera active; no Synapse video session'), '18:21:05'), et('18:21:30'));
    const p = after.state.physicians['PHY-004'];
    const flag = p?.flags.find((f) => f.value.code === 'EXTERNAL_VIDEO_SUSPECTED');
    expect(flag?.value).toMatchObject({ sinceMs: et('18:21:00') });
    expect(flag?.because.map((e) => e.eventId)).toContain('EVT-90061'); // evidence: the camera event (plus the status it was judged against)
    expect(p?.derivedState.value).toBe('Camera Active - No Synapse Session');
    const hospitals = credentialedAt('PHY-004');
    expect(hospitals.map((h) => before.routability[h]?.['PHY-004']?.routable)).toEqual(hospitals.map(() => true));
    for (const h of hospitals) {
      const r = after.routability[h]?.['PHY-004'];
      expect(r?.routable, h).toBe(false);
      expect(r?.reasons.find((x) => x.rule === 'ROUTE_NOT_EXTERNAL_VIDEO')).toMatchObject({ pass: false, affects: 'routable' });
      expect(after.coverage.routableNowIds[h], h).not.toContain('PHY-004');
      expect(before.coverage.routableNowIds[h], h).toContain('PHY-004');
    }
    expect(after.attention.find((a) => a.kind === 'SIGNAL_CONFLICT' && a.physicianIds.includes('PHY-004'))?.headline).toContain('camera on with no Synapse session');
  });

  it('9. brief "Operational Standards" (note completion): note_signed clears the STANDARD_BREACH, closes the consult and drops the open-note count', () => {
    const before = detect(dataset, et('18:22:00'));
    expect(itemsFor(before, 'CON-2115', 'STANDARD_BREACH').map((a) => a.headline)).toEqual([expect.stringContaining('note open')]);
    expect(before.state.consults['CON-2115']).toMatchObject({ open: true, assignedPhysicianId: 'PHY-003', stage: 'Note Pending' });
    const after = detect(accepted(row('EVT-90071', '18:21:00', '18:21:03', 'CON-2115', 'note_signed', 'PHY-003', 'SYN-009', 'Note signed'), '18:21:05'), et('18:22:00'));
    expect(itemsFor(after, 'CON-2115')).toEqual([]);
    expect(after.standards.find((s) => s.consultId === 'CON-2115')).toBeUndefined();
    expect(after.state.consults['CON-2115']).toMatchObject({ open: false, stage: 'Signed Off', signedMs: et('18:21:00') });
    const open = (r: DetectionReport) => r.state.physicians['PHY-003']?.openConsultIds ?? [];
    expect(open(after)).toEqual(open(before).filter((id) => id !== 'CON-2115'));
    expect(open(after)).toHaveLength(open(before).length - 1);
    const notes = (r: DetectionReport) => r.openNotes.find((n) => n.physicianId === 'PHY-003');
    expect(notes(before)?.noteConsultIds).toContain('CON-2115');
    expect(notes(after)?.count).toBe((notes(before)?.count ?? 0) - 1);
    expect(notes(after)?.noteConsultIds).not.toContain('CON-2115');
  });

  it('10. routing rule 5 relief: physician_assigned for a deadlocked consult removes the ROUTING_DEADLOCK item and the DEADLOCK_NOW need', () => {
    const before = decide(dataset, et('18:22:00'));
    expect(before.detection.deadlocks.map((d) => d.consultId)).toContain('CON-2105');
    expect(before.needs.some((n) => n.kind === 'DEADLOCK_NOW' && n.hospitalId === 'SYN-010')).toBe(true);
    // Injected facts are Sevaro's truth; the engine does not re-validate the routing of an assignment it is told about.
    const after = decide(accepted(row('EVT-90081', '18:21:00', '18:21:02', 'CON-2105', 'physician_assigned', 'PHY-001', 'SYN-010', 'Assigned by coordinator'), '18:21:05'), et('18:22:00'));
    expect(after.detection.state.consults['CON-2105']).toMatchObject({ stage: 'Assigned', stageEnteredMs: et('18:21:00'), assignedPhysicianId: 'PHY-001', open: true });
    expect(after.detection.deadlocks.map((d) => d.consultId)).toEqual(before.detection.deadlocks.map((d) => d.consultId).filter((id) => id !== 'CON-2105'));
    expect(itemsFor(after.detection, 'CON-2105', 'ROUTING_DEADLOCK')).toEqual([]);
    expect(after.needs.some((n) => n.kind === 'DEADLOCK_NOW' && n.hospitalId === 'SYN-010')).toBe(false);
    expect(after.needs.some((n) => n.kind === 'DEADLOCK_NOW' && n.hospitalId === 'SYN-005')).toBe(true);
    // The consult now runs the "Assigned, not yet contacted" clock from the assignment.
    expect(after.detection.standards.find((s) => s.consultId === 'CON-2105')).toMatchObject({ standard: 'ASSIGNED_NOT_CONTACTED', clockStartMs: et('18:21:00'), level: 'ok' });
    expect(after.detection.state.physicians['PHY-001']?.consultsThisShift).toBe((before.detection.state.physicians['PHY-001']?.consultsThisShift ?? 0) + 1);
  });

  it('11. routing rule 5 ("retries every 5 minutes"): a burst of routing_attempt_failed keeps one attention item per consult; failures accumulate', () => {
    const before = detect(dataset, et('18:22:00'));
    const burst = [0, 10, 20, 30, 40].map((s, i) => row(`EVT-9009${i}`, `18:21:${String(s).padStart(2, '0')}`, `18:21:${String(s + 2).padStart(2, '0')}`, 'CON-2114', 'routing_attempt_failed', '', 'SYN-005', 'No available credentialed provider; retry scheduled'));
    const after = detect(accepted(burst.join('\n'), '18:21:45'), et('18:22:00'));
    const failures = (r: DetectionReport) => r.deadlocks.find((d) => d.consultId === 'CON-2114')?.routingFailures ?? [];
    expect(failures(after)).toHaveLength(failures(before).length + 5);
    expect(itemsFor(after, 'CON-2114', 'ROUTING_DEADLOCK')).toHaveLength(1);
    expect(itemsFor(after, 'CON-2114', 'ROUTING_DEADLOCK')[0]?.id).toBe(itemsFor(before, 'CON-2114', 'ROUTING_DEADLOCK')[0]?.id);
    expect(itemsFor(after, 'CON-2114', 'ROUTING_DEADLOCK')[0]?.why[0]).toContain(`${failures(after).length} routing_attempt_failed event(s)`);
    expect(new Set(after.attention.map((a) => a.id)).size).toBe(after.attention.length);
    expect(after.state.consults['CON-2114']?.stage).toBe('Triaged');
  });

  it('12. D-26: unknown hospital/physician ids are accepted with a warning naming the id; a row missing a required column is rejected naming the column', () => {
    const r = inject(
      [
        row('EVT-90101', '18:21:00', '18:21:02', 'CON-9101', 'consult_received', '', 'SYN-999', STROKE),
        row('EVT-90102', '18:21:10', '18:21:12', '', 'physician_status_changed', 'PHY-999', '', 'Self-reported status: Available'),
        row('EVT-90103', '18:21:20', '18:21:22', 'CON-2105', 'physician_assigned', '', 'SYN-010', 'Assigned'),
      ].join('\n'),
      '18:21:30',
    );
    expect(r.accepted.map((e) => e.eventId)).toEqual(['EVT-90101', 'EVT-90102']);
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining('unknown hospital_id SYN-999'), expect.stringContaining('unknown physician_id PHY-999')]));
    expect(r.rejected).toEqual([{ line: 3, reason: expect.stringContaining('physician_id') }]);
    expect(r.rejected[0]?.reason).toContain('physician_assigned requires');
    const after = detect(r.dataset, et('18:22:00'));
    expect(after.state.consults['CON-9101']).toMatchObject({ hospitalId: 'SYN-999', hospitalName: null, stage: 'Received', consultType: 'Stroke' });
    expect(after.state.physicians['PHY-999']).toMatchObject({ onRoster: false, shift: null });
    expect(after.state.physicians['PHY-999']?.selfStatus.value).toBe('Available');
    expect(after.state.integrity.warnings.some((w) => w.includes('PHY-999'))).toBe(true);
    // The unknown hospital is not in hospitals.csv, so it has no coverage row and no demand row; CON-2105 stays unassigned.
    expect(after.demand.some((d) => d.hospitalId === 'SYN-999')).toBe(false);
    expect(after.state.consults['CON-2105']?.assignedPhysicianId).toBeNull();
  });

  it('13. CLAUDE.md rule 4 / brief "explicit UTC offset": malformed timestamps and wrong cell counts are rejected per line with the column named', () => {
    const r = inject(
      [
        `EVT-90111,2026-03-17T18:21:00,${iso('18:21:02')},CON-9111,consult_received,,SYN-001,${STROKE}`, // no offset
        `EVT-90112,yesterday evening,${iso('18:21:02')},CON-9112,consult_received,,SYN-001,${STROKE}`, // garbage
        `EVT-90113,${iso('18:21:00')},${iso('18:21:02')},CON-9113,consult_received,,SYN-001`, // 7 cells
        row('EVT-90114', '18:21:00', '18:21:02', 'CON-9114', 'consult_received', '', 'SYN-001', NEURO),
      ].join('\n'),
      '18:21:30',
    );
    expect(r.rejected.map((x) => x.line)).toEqual([1, 2, 3]);
    expect(r.rejected[0]?.reason).toMatch(/column "event_time".*explicit UTC offset/);
    expect(r.rejected[1]?.reason).toMatch(/column "event_time"/);
    expect(r.rejected[2]?.reason).toBe('expected 8 cells, got 7');
    expect(r.accepted.map((e) => e.eventId)).toEqual(['EVT-90114']);
    expect(r.header).toBe('absent');
    expect(detect(r.dataset, et('18:22:00')).state.consults['CON-9114']?.consultType).toBe('General Neuro');
  });

  it('14. D-20 knowledge time: an event dated 30 min ahead of the sim clock has no effect until the clock reaches it', () => {
    const before = detect(dataset, et('18:20:00'));
    const future = accepted(row('EVT-90121', '18:50:00', '18:50:02', 'CON-9121', 'consult_received', '', 'SYN-001', STROKE), '18:20:00');
    expect(future.events).toHaveLength(dataset.events.length + 1);
    const now = detect(future, et('18:20:00'));
    expect(now.state.consults['CON-9121']).toBeUndefined();
    expect(now.state.integrity.appliedCount).toBe(before.state.integrity.appliedCount);
    expect(now.attention.map((a) => a.id)).toEqual(before.attention.map((a) => a.id));
    expect(now.demand.find((d) => d.hospitalId === 'SYN-001')?.count).toBe(before.demand.find((d) => d.hospitalId === 'SYN-001')?.count);
    // Known but not yet happened (ingested_at <= now < event_time): deferred with a warning, still absent (D-20).
    const early = accepted(row('EVT-90122', '18:50:00', '18:20:01', 'CON-9122', 'consult_received', '', 'SYN-001', STROKE), '18:20:00');
    const deferred = detect(early, et('18:21:00'));
    expect(deferred.state.consults['CON-9122']).toBeUndefined();
    expect(deferred.state.integrity.warnings).toContain('1 known event(s) dated after asOf deferred until their event_time');
    // Once the clock reaches it, it is applied at its event_time.
    const later = detect(future, et('18:50:05'));
    expect(later.state.consults['CON-9121']).toMatchObject({ stage: 'Received', receivedMs: et('18:50:00'), hospitalId: 'SYN-001' });
    expect(later.demand.find((d) => d.hospitalId === 'SYN-001')?.contributingConsultIds).toContain('CON-9121');
    expect(later.state.integrity.appliedCount).toBe(detect(dataset, et('18:50:05')).state.integrity.appliedCount + 1);
  });

  it('15. brief "Act" (needs resolved by Sevaro events): assignments for both deadlocks shrink the offer\'s needs; the recommendation is withdrawn (no further offer)', () => {
    // Offer loop on the untouched dataset: propose 18:21, approve 18:22 (delivered to PHY-009).
    const ctx: ActContext = { dataset };
    const { log, offerId } = delivered(ctx, 'PHY-009');
    const offer = foldOffers(log, et('18:22:30')).find((o) => o.offerId === offerId);
    const frozenDeadlocks = offer?.proposal.needs.filter((n) => n.kind === 'DEADLOCK_NOW') ?? [];
    expect(frozenDeadlocks.map((n) => n.hospitalId).sort()).toEqual(['SYN-005', 'SYN-010']);
    // Sevaro then reports both deadlocked consults assigned, plus a shift_started for PHY-011 dated before the 19:00 schedule.
    const resolved = accepted(
      [
        row('EVT-90131', '18:23:00', '18:23:01', 'CON-2105', 'physician_assigned', 'PHY-001', 'SYN-010', 'Assigned by coordinator'),
        row('EVT-90132', '18:23:00', '18:23:01', 'CON-2114', 'physician_assigned', 'PHY-004', 'SYN-005', 'Assigned by coordinator'),
        row('EVT-90133', '18:23:00', '18:23:01', '', 'shift_started', 'PHY-011', '', 'Shift started'),
      ].join('\n'),
      '18:23:02',
    );
    const before = decideWithLog(ctx, log, et('18:22:30'));
    const after = decideWithLog({ dataset: resolved }, log, et('18:23:05'));
    // The DEADLOCK_NOW needs the offer was proposed against no longer exist.
    expect(before.needs.filter((n) => n.kind === 'DEADLOCK_NOW').map((n) => n.hospitalId).sort()).toEqual(['SYN-005', 'SYN-010']);
    expect(after.needs.filter((n) => n.kind === 'DEADLOCK_NOW')).toEqual([]);
    expect(after.detection.deadlocks).toEqual([]);
    for (const n of frozenDeadlocks) expect(after.needs.find((x) => x.id === n.id), n.id).toBeUndefined();
    // OQ-29: a shift_started dated before the scheduled 19:00 start does not confirm the arrival (tolerance 0).
    expect(after.detection.staffing.shifts.find((s) => s.source === 'scheduled_arrival' && s.physicianId === 'PHY-011')?.confirmation).toBe('expected');
    // "Recommendation withdrawn" = the physician's offer now covers fewer needs and is worth less than when it was proposed...
    const entry = (d: typeof before) => d.ledger.find((e) => e.physicianId === 'PHY-009');
    expect(entry(after)?.coversNeeds.length).toBeLessThan(entry(before)?.coversNeeds.length ?? 0);
    expect(entry(after)?.coversNeeds.every((id) => entry(before)?.coversNeeds.includes(id))).toBe(true);
    expect(entry(after)?.value ?? 0).toBeLessThan(entry(before)?.value ?? 0);
    const plain = (d: Dataset, hms: string) => decide(d, et(hms)).recommendedOffer;
    expect(plain(resolved, '18:23:05')?.value ?? 0).toBeLessThan(plain(dataset, '18:23:05')?.value ?? 0);
    expect(plain(resolved, '18:23:05')?.coversNeeds.length).toBeLessThan(plain(dataset, '18:23:05')?.coversNeeds.length ?? 0);
    // ...and the sequential loop offers nobody else: PHY-009's offer is still open (one open offer per physician), nobody else is eligible.
    const next = recommendNext({ dataset: resolved }, log, et('18:23:05'));
    expect(next.physicianId).toBeNull();
    expect(next.why.join(' ')).toContain('no further eligible physician');
    // A coordinator re-proposal for the resolved deadlock need is refused as an unknown need at this instant.
    const again = run({ dataset: resolved }, log, { type: 'proposeOffer', commandId: 'p-again', actor: COORD, physicianId: 'PHY-009', needIds: frozenDeadlocks.map((n) => n.id) }, '18:23:05');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(['INVALID_STATE', 'OPEN_OFFER_EXISTS']).toContain(again.code);
    // The delivered offer itself is unaffected by Sevaro events (our log is separate): the lead can still cancel it.
    const cancelled = must({ dataset: resolved }, log, { type: 'cancelOffer', commandId: 'c-9', actor: LEAD, offerId, reason: 'deadlocks resolved in Synapse' }, '18:23:10');
    expect(cancelled.at(-1)).toMatchObject({ type: 'offer_cancelled', payload: { offerId, cause: 'manual' } });
  });
});
