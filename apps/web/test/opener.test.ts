import { DATA_DIR } from './helpers';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BRAIN_AGING_WEEKS_PER_MIN, CLINICAL_SOURCE_CITATION, DELAY_PASS_THROUGH_RATIO, NEURONS_LOST_PER_MIN, SYNAPSES_LOST_PER_MIN, impactSummary, openerSummary, rewind } from '@lookahead/engine';
import { loadDataset } from '@lookahead/engine/loaders';
import * as resetRoute from '@/app/api/demo/reset/route';
import { OpenerContent, OpenerModal, clippedImpact, impactCounter, joinNames, openerSentences, scaled } from '@/components/Opener';
import { ImpactPanel } from '@/components/RewindView';
import { clinicalConstants, openerFor } from '@/server/opener';
import { rewindFor } from '@/server/rewind';
import { disposeStore, getReadyStore } from '@/server/store';

/**
 * Sprint A1/A3 (LOOKAHEAD-DEFINED): the /opener glue reads the same rewind
 * report the engine produces (never recomputed), the client-side impact
 * mirror used by the /rewind slider equals the engine's impactSummary at
 * every origin, and the rendered sentences carry only computed values.
 */

const dataset = loadDataset(DATA_DIR);
const PLACEHOLDER = /undefined|NaN|null|\{|TODO/;

beforeEach(async () => {
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterAll(() => disposeStore());

describe('openerFor (server glue)', () => {
  it('equals openerSummary / impactSummary on the engine rewind at the store instant', async () => {
    const s = (await getReadyStore()).snapshot();
    const d = openerFor(s);
    expect(d.ready).toBe(true);
    const r = rewind(s.dataset, s.snapshotMs);
    expect(d.opener).toEqual(openerSummary(r, s.dataset));
    expect(d.impact).toEqual(impactSummary(r));
    expect(d.assumptions).toEqual(r.assumptions);
    expect(d.clinical).toEqual(clinicalConstants());
  });

  it('clinical constants are exactly the engine constants', () => {
    expect(clinicalConstants()).toEqual({
      citation: CLINICAL_SOURCE_CITATION,
      neuronsPerMin: NEURONS_LOST_PER_MIN,
      synapsesPerMin: SYNAPSES_LOST_PER_MIN,
      agingWeeksPerMin: BRAIN_AGING_WEEKS_PER_MIN,
      passThroughRatio: DELAY_PASS_THROUGH_RATIO,
    });
  });

  it('sentences carry the computed numbers and no placeholder text', async () => {
    const d = openerFor((await getReadyStore()).snapshot());
    if (d.opener === null) {
      expect(d.impact?.zero ?? true).toBe(true);
      return;
    }
    const o = d.opener;
    const ss = openerSentences(o);
    expect(ss).toHaveLength(3);
    for (const s of ss) expect(s).not.toMatch(PLACEHOLDER);
    const third = ss[2];
    expect(third).toContain(o.hospitalName);
    expect(third).toContain(`${o.kind === 'anticipatory' ? o.anticipatoryWaitMin : o.reactiveWaitMin} min, not ${o.actualWaitMin}`);
    if (o.kind === 'anticipatory') {
      expect(ss[0]).toContain(o.standbyPhysicianDisplayName);
      expect(ss[1]).toContain(joinNames(o.coveredHospitalNames));
    }
    if (d.impact !== null) {
      const c = impactCounter(d.impact);
      expect(c).not.toMatch(PLACEHOLDER);
      if (!d.impact.zero) expect(c).toContain(`${d.impact.strokeMinutesAverted} stroke consult-minutes averted`);
    }
  });
});

describe('clippedImpact (client mirror of impactSummary)', () => {
  const c = clinicalConstants();
  const NOW = Math.max(...dataset.events.map((e) => e.ingestedAt));
  const r = rewind(dataset, NOW);

  it('equals impactSummary at every origin and without untilMs', () => {
    const strip = (x: ReturnType<typeof impactSummary>) => ({ actualMin: x.actualMin, reactiveMin: x.reactiveMin, anticipatoryMin: x.anticipatoryMin, strokeMinutesAverted: x.strokeMinutesAverted, neuronsEstimate: x.neuronsEstimate, synapsesEstimate: x.synapsesEstimate, agingWeeksEstimate: x.agingWeeksEstimate, zero: x.zero });
    expect(clippedImpact(r.lines, c)).toEqual(strip(impactSummary(r)));
    for (const o of r.origins) expect(clippedImpact(r.lines, c, o.tMs)).toEqual(strip(impactSummary(r, { untilMs: o.tMs })));
    expect(clippedImpact(r.lines, c, r.evalHorizonMs)).toEqual(strip(impactSummary(r, { untilMs: r.evalHorizonMs })));
  });

  it('zero state with standby disabled matches the engine (nothing averted)', () => {
    const off = rewind(dataset, NOW, { standbyEnabled: false });
    const mine = clippedImpact(off.lines, c);
    expect(mine.zero).toBe(true);
    expect(mine.strokeMinutesAverted).toBe(impactSummary(off).strokeMinutesAverted);
    expect(impactCounter(impactSummary(off))).toBe('No stroke consult-minutes averted by anticipation on this dataset');
  });

  it('scaled() keeps one decimal below 10 and rounds above', () => {
    expect(scaled(NEURONS_LOST_PER_MIN * 2, 1e6)).toBe(String(Math.round(((NEURONS_LOST_PER_MIN * 2) / 1e6) * 10) / 10));
    expect(scaled(NEURONS_LOST_PER_MIN * 100, 1e6)).toBe(Math.round((NEURONS_LOST_PER_MIN * 100) / 1e6).toLocaleString('en-US'));
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('OpenerContent / OpenerModal markup', () => {
  // Vitest compiles TSX with the classic runtime here (tsconfig jsx: preserve); Next uses the automatic one.
  (globalThis as { React?: unknown }).React = React;
  const visibleText = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

  it('renders the three sentences, timeline, impact, assumptions and start link with computed text only', async () => {
    const d = openerFor((await getReadyStore()).snapshot());
    const html = renderToStaticMarkup(React.createElement(OpenerContent, { data: d }));
    expect(visibleText(html)).not.toMatch(PLACEHOLDER);
    for (const id of ['opener', 'opener-assumptions', 'opener-start']) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain('href="/"');
    if (d.opener !== null) {
      expect(html.match(/data-testid="opener-sentence"/g)?.length).toBe(3);
      expect(html).toContain('data-testid="opener-timeline"');
      for (const s of openerSentences(d.opener)) expect(visibleText(html)).toContain(s);
    }
    if (d.impact !== null) expect(html).toContain('data-testid="opener-impact"');
    if (d.assumptions !== null) for (const v of [d.assumptions.leadApprovalMin, d.assumptions.ackMin, d.assumptions.activationApprovalMin, d.assumptions.acceptMin]) expect(visibleText(html)).toContain(`${v} min`);
  });

  it('modal is an open dialog with a native close button', async () => {
    const d = openerFor((await getReadyStore()).snapshot());
    const html = renderToStaticMarkup(React.createElement(OpenerModal, { data: d }));
    expect(html).toMatch(/<dialog[^>]*open=""/);
    expect(html).toContain('data-testid="opener-modal"');
    expect(html).toMatch(/<form[^>]*method="dialog"/);
    expect(html).toContain('data-testid="opener-close"');
  });

  it('honest empty state when no episode helps', () => {
    const html = renderToStaticMarkup(React.createElement(OpenerContent, { data: { ready: true, opener: null, impact: null, assumptions: null, clinical: clinicalConstants() } }));
    expect(html).toContain('data-testid="opener-empty"');
    expect(html).not.toContain('data-testid="opener-sentence"');
    expect(visibleText(html)).not.toMatch(PLACEHOLDER);
  });
});

describe('/rewind impact panel markup', () => {
  (globalThis as { React?: unknown }).React = React;
  const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  it('at the last origin states the engine impactSummary numbers; at the first origin the clipped ones; footer always present', async () => {
    const s = (await getReadyStore()).snapshot();
    const dto = rewindFor(s);
    if (dto === null) throw new Error('rewind not available');
    const c = clinicalConstants();
    const engineReport = rewind(s.dataset, s.snapshotMs);
    const full = impactSummary(engineReport);
    const last = text(renderToStaticMarkup(React.createElement(ImpactPanel, { report: dto, idx: dto.origins.length - 1, clinical: c })));
    expect(last).not.toMatch(PLACEHOLDER);
    expect(last).toContain('Not a clinical outcome measurement');
    if (full.zero) expect(last).toContain('anticipation did not reduce stroke delay');
    else {
      expect(last).toContain(`averted ${full.strokeMinutesAverted} stroke consult-minutes`);
      expect(last).toContain(`~${scaled(full.neuronsEstimate, 1e6)}M neurons`);
      expect(last).toContain(`~${scaled(full.synapsesEstimate, 1e9)}B synapses`);
      expect(last).toContain(`~${scaled(full.agingWeeksEstimate, 1)} weeks of brain aging`);
    }
    const t0 = dto.origins[0]?.tMs ?? dto.fromMs;
    const first = text(renderToStaticMarkup(React.createElement(ImpactPanel, { report: dto, idx: 0, clinical: c })));
    const clipped = impactSummary(engineReport, { untilMs: t0 });
    expect(first).not.toMatch(PLACEHOLDER);
    if (!full.zero && !clipped.zero) expect(first).toContain(`averted ${clipped.strokeMinutesAverted} stroke consult-minutes`);
    // Without the clinical constants prop the minutes are still stated, with no extrapolation.
    const bare = text(renderToStaticMarkup(React.createElement(ImpactPanel, { report: dto, idx: dto.origins.length - 1, clinical: undefined })));
    expect(bare).not.toContain('neurons');
    expect(bare).not.toMatch(PLACEHOLDER);
  });
});
