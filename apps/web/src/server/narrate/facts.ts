import type { OfferDTO, PhysicianRowDTO, ViewDTO, WhatIfRowDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';

/**
 * Narration input (Session 7): ONLY engine-computed facts for one item,
 * de-identified so the text is safe to read aloud or paste anywhere: no
 * consult or event ids, no clinical terms (the engine's PHI denylist would
 * reject them), physician and hospital ids replaced by names. The model never
 * sees anything else, and the fidelity guard checks its output against these
 * same strings.
 */

export type NarrationKind = 'attention' | 'recommendation' | 'lead_briefing';

export interface NarrationFacts {
  readonly kind: NarrationKind;
  readonly id: string;
  readonly title: string;
  /** Complete, de-identified fact sentences. */
  readonly points: readonly string[];
  /** Proper names the text may use (hospitals, physicians). */
  readonly names: readonly string[];
}

const KIND_WORD: Record<string, string> = { DEADLOCK_NOW: 'no routable physician', HARD_GAP: 'hard coverage gap', AT_RISK: 'at-risk coverage' };

/** id -> display name for physicians and hospitals in the view. */
export function nameMap(view: ViewDTO): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of view.physicians) m.set(p.physicianId, p.name);
  for (const r of view.ledger) m.set(r.physicianId, r.name);
  for (const r of view.coverage.rows) m.set(r.hospitalId, r.hospitalName);
  return m;
}

/** Strips citations and identifiers, replaces clinical terms; deterministic. */
export function sanitize(text: string, names: ReadonlyMap<string, string>): string {
  let s = text;
  // "Dr. Daniel Kim (PHY-002)" -> "Dr. Daniel Kim"; bare ids -> names.
  s = s.replace(/\s*\((?:PHY|SYN)-\d+\)/g, '');
  s = s.replace(/\b(?:PHY|SYN)-\d+\b/g, (id) => names.get(id) ?? 'a physician');
  // Rule and open-question citations: "(OQ-24(b))", "(brief ...)", "OQ-05".
  s = s.replace(/\s*\((?:[^()]|\([^()]*\))*\b(?:OQ-\d+|brief)\b(?:[^()]|\([^()]*\))*\)/g, '');
  s = s.replace(/\bOQ-\d+(?:\([a-z]\))?/g, '');
  s = s.replace(/\bEVT-\d+\b/g, 'an event');
  s = s.replace(/\bCON-\d+ Stroke\b/g, 'A time-critical consult').replace(/\bCON-\d+ General Neuro\b/g, 'A general consult');
  s = s.replace(/\bCON-\d+\b/g, 'a consult');
  s = s.replace(/\(Stroke(, [^)]*)?\)/g, '(time-critical$1)').replace(/\(General Neuro(, [^)]*)?\)/g, '(general$1)');
  s = s.replace(/\bGeneral Neuro\b/gi, 'general').replace(/\bstroke\b/gi, 'time-critical');
  s = s.replace(/CT\/CTA or Imaging Pending/gi, 'hospital workup pending').replace(/\bImaging Review \(imaging back, video not started\)/gi, 'results review');
  s = s.replace(/\bimaging review\b/gi, 'results review').replace(/\bimaging\b/gi, 'workup').replace(/\bCT\/CTA\b/gi, 'workup');
  s = s.replace(/\bneuro\w*\b/gi, '');
  s = s.replace(/\brouting_attempt_failed event\(s\)/g, 'failed routing attempts');
  s = s.replace(/\b([a-z]+(?:_[a-z]+)+) event\(s\)/g, (_, w: string) => `${w.replace(/_/g, ' ')} events`);
  s = s.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (w) => w.replace(/_/g, ' '));
  s = s.replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

function namesOf(view: ViewDTO, ids: readonly string[]): string[] {
  const m = nameMap(view);
  return [...new Set(ids.map((id) => m.get(id)).filter((n): n is string => n !== undefined))];
}

export function attentionFacts(view: ViewDTO, id: string): NarrationFacts | null {
  const a = view.attention.find((x) => x.id === id);
  if (a === undefined) return null;
  const names = nameMap(view);
  const physicianNames = view.physicians.filter((p: PhysicianRowDTO) => a.why.some((w) => w.includes(p.physicianId) || w.includes(p.name))).map((p) => p.name);
  return {
    kind: 'attention',
    id,
    title: sentence(sanitize(a.headline, names)),
    points: [
      `Severity ${a.severity}, rank ${a.rank} of ${view.attention.length}, ${a.timeToImpactMs <= 0 ? 'impact now' : `impact in ${Math.round(a.timeToImpactMs / 60_000)} min`}.`,
      ...a.why.map((w) => sentence(sanitize(w, names))).filter((w) => w.length > 3),
    ],
    names: [...new Set([...namesOf(view, a.hospitalIds), ...namesOf(view, a.physicianIds), ...physicianNames])],
  };
}

export function recommendationFacts(view: ViewDTO): NarrationFacts | null {
  const r = view.recommendation;
  if (r === null) return null;
  const names = nameMap(view);
  const reassign = r.steps.find((s) => s.kind === 'REASSIGN_CONSULT');
  const blockers = (reassign?.detail.slice(1) ?? []).map((d) => sentence(sanitize(d, names)));
  const o = view.recommendedOffer;
  const blocked = [...names.values()].filter((n) => blockers.some((b) => b.startsWith(n)));
  const points = [
    reassign === undefined
      ? 'Reassignment does not apply.'
      : reassign.candidates.length === 0
        ? `Reassignment is not possible: ${blocked.length > 0 ? `${blocked.join(' and ')} cannot take it` : 'no routable physician'}.`
        : `Reassign to ${names.get(reassign.candidates[0]?.physicianId ?? '') ?? 'the next routable physician'}.`,
    'Escalate to the clinical lead, who approves split-shift offers.',
    ...(o === null
      ? ['No off-shift physician passes every eligibility rule.']
      : [
          `Offer ${o.name} a split shift from ${etHm(o.window.startMs)} to ${etHm(o.window.endMs)} ET, ${Math.round(o.window.effectiveMinutes / 60)} hours.`,
          `Scope: ${o.scopeNames.join(', ')}.`,
          `Starting count ${o.seededConsultCount} consults, so routing does not send every call to the new physician.`,
          `${o.name} is the only one of ${view.ledger.length} off-shift physicians who passes every rule.`,
        ]),
    ...blockers,
  ];
  return {
    kind: 'recommendation',
    id: r.attentionItemId,
    title: sentence(sanitize(r.headline, names)),
    points,
    names: [...new Set([...(o === null ? [] : [o.name, ...o.scopeNames]), ...view.coverage.rows.filter((h) => r.headline.includes(h.hospitalName)).map((h) => h.hospitalName), ...blockers.flatMap((b) => [...names.values()].filter((n) => b.includes(n)))])],
  };
}

function effect(r: WhatIfRowDTO): string | null {
  const what = `${r.hospitalName} ${KIND_WORD[r.kind] ?? 'need'} from ${etHm(r.startMs)}`;
  if (r.outcome === 'closed') return `${what}: closed.`;
  if (r.outcome === 'downgraded') return `${what}: downgraded to at-risk coverage.`;
  if (r.outcome === 'shortened' && r.remainingMinutes !== null) return `${what}: ${r.beforeMinutes} min shrinks to ${r.remainingMinutes} min.`;
  return null;
}

export function leadBriefingFacts(view: ViewDTO, offerId: string): NarrationFacts | null {
  const o: OfferDTO | undefined = view.offers.find((x) => x.offerId === offerId);
  if (o === undefined) return null;
  const others = o.ledger.filter((l) => !l.eligible).length;
  const whatIf = view.offerContext.offerId === offerId ? view.offerContext.whatIf.rows : [];
  const effects = whatIf.map(effect).filter((e): e is string => e !== null).slice(0, 4);
  return {
    kind: 'lead_briefing',
    id: offerId,
    title: `Approve a split shift for ${o.name} from ${etHm(o.window.startMs)} to ${etHm(o.window.endMs)} ET.`,
    points: [
      `Hospitals: ${o.hospitalNames.join(', ')}.`,
      `${o.name} passes every eligibility rule; ${others} of the ${o.ledger.length} off-shift physicians do not.`,
      `Routing is limited to those hospitals and starts at ${o.seededConsultCount} consults, so the new physician is not sent every call.`,
      ...(effects.length > 0 ? [`If accepted: ${effects.join(' ')}`] : []),
    ],
    names: [o.name, ...o.hospitalNames],
  };
}

export function factsFor(view: ViewDTO, kind: NarrationKind, id: string): NarrationFacts | null {
  if (kind === 'attention') return attentionFacts(view, id);
  if (kind === 'recommendation') return recommendationFacts(view);
  return leadBriefingFacts(view, id);
}
