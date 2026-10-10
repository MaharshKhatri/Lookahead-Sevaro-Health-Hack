import type { LedgerEntry } from '@lookahead/engine';
import type { LedgerRowDTO, LedgerRuleDTO } from '@/lib/dto';

/**
 * LEDGER tab chips (brief "Coverage and Split-Shift Eligibility": "show every
 * off-shift physician considered and the rule each one passed or failed").
 * The engine's rule `detail` strings carry the numbers; this only shortens
 * them for a chip ("Rest 11.6 h ≥ 10", "59+2=61 > 60"). The full detail is
 * always kept for the tooltip, and an unrecognised detail falls back to the
 * rule label, so a wording change in the engine degrades to a plain chip.
 */

export const RULE_LABELS: Readonly<Record<string, string>> = {
  ELIG_OPT_IN: 'Opt-in',
  ELIG_CREDENTIALED_AT_GAP: 'Credentialed at gap',
  ELIG_REST_10H: 'Rest ≥ 10 h',
  ELIG_HOURS_60: '7-day hours ≤ 60',
  ELIG_NO_SCHEDULE_OVERLAP: 'No shift overlap',
  ELIG_MIN_OFFER_2H: 'Offer ≥ 2 h',
  SAFETY_ONE_OPEN_OFFER: '≤ 1 open offer',
  SAFETY_THREE_OFFERS_PER_WEEK: '≤ 3 offers / week',
};

const cmp = (op: string) => ({ '>=': '≥', '<=': '≤', '<': '<', '>': '>' })[op] ?? op;

export function ruleChip(rule: string, pass: boolean | null, detail: string): string {
  const label = RULE_LABELS[rule] ?? rule;
  if (pass === null) return `${label}: n/a`;
  let m: RegExpExecArray | null;
  switch (rule) {
    case 'ELIG_OPT_IN':
      m = /=\s*(\w+)/.exec(detail);
      return m ? `Opt-in ${m[1]}` : label;
    case 'ELIG_CREDENTIALED_AT_GAP':
      m = /gap hospital\(s\) ([A-Z0-9, -]+?) \(/.exec(detail);
      if (pass && m) return `Gap: ${m[1]}`;
      return pass ? label : 'No gap hospital';
    case 'ELIG_REST_10H':
      m = /([\d.]+) h (>=|<) ([\d.]+) h/.exec(detail);
      return m ? `Rest ${m[1]} h ${cmp(m[2] ?? '')} ${m[3]}` : label;
    case 'ELIG_HOURS_60':
      m = /([\d.]+) h \+ (?:offered |minimum )?([\d.]+) h(?: offer)? = ([\d.]+) h (<=|>) ([\d.]+)/.exec(detail);
      if (m) return `${m[1]}+${m[2]}=${m[3]} ${cmp(m[4] ?? '')} ${m[5]}`;
      m = /([\d.]+) h worked; headroom ([\d.]+) h (>=|<) ([\d.]+) h/.exec(detail);
      return m ? `${m[1]} h; headroom ${m[2]} ${cmp(m[3] ?? '')} ${m[4]}` : label;
    case 'ELIG_NO_SCHEDULE_OVERLAP':
      m = /starts ([\d.]+ (?:h|min)) after offered start/.exec(detail);
      return m ? `Next shift +${m[1]}` : label;
    case 'ELIG_MIN_OFFER_2H':
      m = /= (\d+) min, minus (\d+) min to come online = (\d+) min (>=|<) (\d+)/.exec(detail);
      return m ? `${m[1]}−${m[2]}=${m[3]} ${cmp(m[4] ?? '')} ${m[5]} min` : label;
    case 'SAFETY_ONE_OPEN_OFFER':
      m = /^(\d+) open offer/.exec(detail);
      return m ? `Open ${m[1]}/1` : label;
    case 'SAFETY_THREE_OFFERS_PER_WEEK':
      m = /^(\d+) offer\(s\) since/.exec(detail);
      return m ? `Week ${m[1]}/3` : label;
    default:
      return label;
  }
}

export function ledgerRow(e: LedgerEntry): LedgerRowDTO {
  const rules: LedgerRuleDTO[] = e.rules.map((r) => ({ rule: r.rule, label: RULE_LABELS[r.rule] ?? r.rule, pass: r.pass, chip: ruleChip(r.rule, r.pass, r.detail), detail: r.detail }));
  const w = e.offerWindow;
  return {
    physicianId: e.physicianId,
    name: e.name,
    eligible: e.eligible,
    rank: e.rank,
    rules,
    failedRules: e.rules.filter((r) => r.pass === false).map((r) => r.rule),
    window: w === null ? null : { startMs: w.startMs, endMs: w.endMs, minutesToOnline: w.minutesToOnline, effectiveMinutes: w.effectiveMinutes, bindingCap: w.bindingCap },
    value: e.value,
    scopeHospitalIds: e.scopeHospitalIds,
  };
}
