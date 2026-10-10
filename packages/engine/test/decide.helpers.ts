import { decide, type DecisionReport, type LedgerEntry, type Need } from '../src';
import { clock, dataset } from './detect.helpers';
import { et } from './helpers';

export { dataset, clock };
let cached: DecisionReport | null = null;
/** The 18:20 decision report, computed once per test file. */
export function decision1820(): DecisionReport {
  cached ??= decide(dataset, et('18:20:00'));
  return cached;
}

export const end = (n: Need) => (n.endMs === 'beyond_horizon' ? 'beyond_horizon' : clock(n.endMs));
export const needRow = (n: Need) => [n.kind, n.hospitalId, clock(n.startMs), end(n), n.required, n.staffedConfirmed, n.staffedExpected] as const;

/** Compact, stable view of a ledger entry for the golden file. */
export const ledgerRow = (e: LedgerEntry) => ({
  physicianId: e.physicianId,
  eligible: e.eligible,
  rank: e.rank,
  value: e.value,
  failed: e.rules.filter((r) => r.pass === false).map((r) => r.rule),
  scope: e.scopeHospitalIds,
  window:
    e.offerWindow === null
      ? null
      : {
          start: clock(e.offerWindow.startMs),
          end: clock(e.offerWindow.endMs),
          minutesToOnline: e.offerWindow.minutesToOnline,
          offeredMinutes: e.offerWindow.offeredMinutes,
          effectiveMinutes: e.offerWindow.effectiveMinutes,
          bindingCap: e.offerWindow.bindingCap,
        },
  rules: Object.fromEntries(e.rules.map((r) => [r.rule, { pass: r.pass, detail: r.detail }])),
});
