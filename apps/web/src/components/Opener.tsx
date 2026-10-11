import type { ImpactSummary, OpenerSummary } from '@lookahead/engine';
import { etHm } from '@/lib/format';
import type { ClinicalConstantsDTO, OpenerPageDTO } from '@/server/opener';

/**
 * Opener (final polish sprint A1, LOOKAHEAD-DEFINED): one concrete
 * counterfactual from the rewind, in three computed sentences, a ~60 px
 * timeline, the impact counter and the assumptions box. Server-compatible (no
 * hooks): the /?opener=1 modal closes natively (<dialog> + form method
 * "dialog"), so no client state is needed. The pure helpers below are also
 * used by the client RewindView (A3) and unit-tested against the engine's
 * impactSummary in apps/web/test/opener.test.ts. Every number is engine output.
 */

const MIN = 60_000;
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** "A", "A and B", "A, B and C". */
export function joinNames(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs.at(-1) ?? ''}`;
}

/** Scaled estimate: one decimal below 10, whole numbers above (e.g. 1900000 x 12 / 1e6 = "22.8" -> "23"). */
export function scaled(n: number, unit: number): string {
  const v = n / unit;
  return v < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v).toLocaleString('en-US');
}

/** The three opener sentences (template fixed, every value computed). */
export function openerSentences(o: OpenerSummary): [string, string, string] {
  const who = o.standbyPhysicianDisplayName === '' ? 'the relief physician' : o.standbyPhysicianDisplayName;
  const actual = o.actualStillUnassigned ? `${o.actualWaitMin} (still unassigned when the data ends; counted to ${etHm(o.actualGapEndMs)} ET)` : `${o.actualWaitMin}`;
  const online = o.onlineTimeMs === null ? null : etHm(o.onlineTimeMs);
  if (o.kind === 'anticipatory') {
    return [
      o.preAlertTimeMs === null ? `Lookahead would have recommended a standby pre-alert to ${who}.` : `At ${etHm(o.preAlertTimeMs)} ET, Lookahead would have pre-alerted ${who}.`,
      online === null ? `They would have come online for ${joinNames(o.coveredHospitalNames)}.` : `By ${online} ET, they would have been online for ${joinNames(o.coveredHospitalNames)}.`,
      `The stroke consult at ${o.hospitalName} would have waited ${o.anticipatoryWaitMin} min, not ${actual}.`,
    ];
  }
  return [
    'On this dataset, anticipatory standby would not have shortened any stroke wait.',
    `${o.activationTimeMs === null ? 'Reacting at the latest data' : `Reacting at ${etHm(o.activationTimeMs)} ET`}, Lookahead would have offered a split shift to ${who}${online === null ? '' : `, online by ${online} ET`}.`,
    `The stroke consult at ${o.hospitalName} would have waited ${o.reactiveWaitMin} min, not ${actual}.`,
  ];
}

/** "{X} stroke consult-minutes averted · ~{Y}M neurons" or the honest zero version. */
export function impactCounter(i: ImpactSummary): string {
  if (i.zero) return 'No stroke consult-minutes averted by anticipation on this dataset';
  return `${i.strokeMinutesAverted} stroke consult-minutes averted · ~${scaled(i.neuronsEstimate, 1e6)}M neurons`;
}

export interface ImpactLineInput {
  readonly kind: 'actual' | 'reactive' | 'anticipatory';
  readonly totalStrokeMinutesUnassigned: number;
  readonly perConsult: readonly { readonly receivedMs: number; readonly minutesUnassigned: number }[];
}

export interface ClientImpact {
  readonly actualMin: number;
  readonly reactiveMin: number;
  readonly anticipatoryMin: number;
  readonly strokeMinutesAverted: number;
  readonly neuronsEstimate: number;
  readonly synapsesEstimate: number;
  readonly agingWeeksEstimate: number;
  readonly zero: boolean;
}

/**
 * Client-side mirror of the engine's impactSummary (clinical/impact.ts): each
 * consult contributes the part of [receivedMs, receivedMs + minutesUnassigned)
 * before untilMs; without untilMs the line totals. Same rounding, same
 * constants (passed from the server). Tested for equality with impactSummary.
 */
export function clippedImpact(lines: readonly ImpactLineInput[], c: Pick<ClinicalConstantsDTO, 'neuronsPerMin' | 'synapsesPerMin' | 'agingWeeksPerMin' | 'passThroughRatio'>, untilMs?: number): ClientImpact {
  const minutes = (kind: ImpactLineInput['kind']): number => {
    const l = lines.find((x) => x.kind === kind);
    if (l === undefined) return 0;
    if (untilMs === undefined) return l.totalStrokeMinutesUnassigned;
    return round1(l.perConsult.reduce((s, r) => s + Math.max(0, Math.min(r.minutesUnassigned, (untilMs - r.receivedMs) / MIN)), 0));
  };
  const actualMin = minutes('actual');
  const reactiveMin = minutes('reactive');
  const anticipatoryMin = minutes('anticipatory');
  const averted = round1(Math.max(0, actualMin - anticipatoryMin));
  const delay = averted * c.passThroughRatio;
  return {
    actualMin,
    reactiveMin,
    anticipatoryMin,
    strokeMinutesAverted: averted,
    neuronsEstimate: delay * c.neuronsPerMin,
    synapsesEstimate: delay * c.synapsesPerMin,
    agingWeeksEstimate: round1(delay * c.agingWeeksPerMin),
    zero: averted <= 0,
  };
}

const TW = 800;
const TH = 60;

/** ~60 px timeline: red bar = actual unassigned gap, teal marker = Lookahead action, teal bar = would-have wait. */
function Timeline({ o }: { readonly o: OpenerSummary }) {
  const actionMs = o.kind === 'anticipatory' ? (o.preAlertTimeMs ?? o.activationTimeMs) : o.activationTimeMs;
  const points = [o.actualGapOpenedMs, o.actualGapEndMs, o.wouldHaveAssignedMs, ...(actionMs === null ? [] : [actionMs]), ...(o.onlineTimeMs === null ? [] : [o.onlineTimeMs])];
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = Math.max(MIN, hi - lo);
  const x = (ms: number): number => 8 + ((ms - lo) / span) * (TW - 16);
  const wouldMin = o.kind === 'anticipatory' ? o.anticipatoryWaitMin : o.reactiveWaitMin;
  const actionWord = o.kind === 'anticipatory' ? 'pre-alert' : 'split-shift offer';
  const summary = `Actual unassigned gap at ${o.hospitalName}: ${etHm(o.actualGapOpenedMs)} to ${etHm(o.actualGapEndMs)} ET (${o.actualWaitMin} min). ${actionMs === null ? '' : `Lookahead ${actionWord} at ${etHm(actionMs)} ET. `}${o.onlineTimeMs === null ? '' : `Relief online ${etHm(o.onlineTimeMs)} ET. `}Would have been assigned at ${etHm(o.wouldHaveAssignedMs)} ET (${wouldMin} min).`;
  return (
    <figure className="mt-8" data-testid="opener-timeline">
      <svg viewBox={`0 0 ${TW} ${TH}`} className="h-[60px] w-full" role="img" aria-label={summary} preserveAspectRatio="none">
        <title>{summary}</title>
        <line x1={8} x2={TW - 8} y1={TH / 2} y2={TH / 2} stroke="var(--color-border)" />
        <rect x={x(o.actualGapOpenedMs)} y={8} width={Math.max(2, x(o.actualGapEndMs) - x(o.actualGapOpenedMs))} height={16} rx={2} fill="var(--color-critical)">
          <title>{`Actual: unassigned ${etHm(o.actualGapOpenedMs)}-${etHm(o.actualGapEndMs)} ET, ${o.actualWaitMin} min`}</title>
        </rect>
        <rect x={x(o.actualGapOpenedMs)} y={36} width={Math.max(2, x(o.wouldHaveAssignedMs) - x(o.actualGapOpenedMs))} height={16} rx={2} fill="var(--color-ok)">
          <title>{`With Lookahead: unassigned ${etHm(o.actualGapOpenedMs)}-${etHm(o.wouldHaveAssignedMs)} ET, ${wouldMin} min`}</title>
        </rect>
        {actionMs !== null && (
          <g>
            <line x1={x(actionMs)} x2={x(actionMs)} y1={2} y2={TH - 2} stroke="var(--color-ok)" strokeWidth={3} />
            <title>{`Lookahead ${actionWord} at ${etHm(actionMs)} ET`}</title>
          </g>
        )}
        {o.onlineTimeMs !== null && (
          <g>
            <line x1={x(o.onlineTimeMs)} x2={x(o.onlineTimeMs)} y1={2} y2={TH - 2} stroke="var(--color-ok)" strokeWidth={1.5} strokeDasharray="3 3" />
            <title>{`Relief online at ${etHm(o.onlineTimeMs)} ET`}</title>
          </g>
        )}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-muted">
        <span><span className="mr-1 inline-block h-3 w-3 rounded-sm bg-critical align-middle" />actual gap</span>
        <span><span className="mr-1 inline-block h-3 w-1 bg-ok align-middle" />Lookahead action</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded-sm bg-ok align-middle" />would-have wait</span>
        <span className="num w-full">{summary}</span>
      </figcaption>
    </figure>
  );
}

function Assumptions({ a }: { readonly a: OpenerPageDTO['assumptions'] }) {
  return (
    <details className="mt-8 rounded border border-border bg-panel p-4" data-testid="opener-assumptions">
      <summary className="cursor-pointer text-[15px] font-semibold">Assumptions (LOOKAHEAD-DEFINED, illustrative)</summary>
      {a === null ? (
        <p className="mt-2 text-[14px] text-muted">The rewind is not available, so no latencies were applied.</p>
      ) : (
        <div className="mt-3 text-[14px]">
          <table className="w-full max-w-[420px] text-left">
            <tbody>
              <tr><td className="text-muted">lead approval</td><td className="num text-right">{a.leadApprovalMin} min</td></tr>
              <tr><td className="text-muted">acknowledgment</td><td className="num text-right">{a.ackMin} min</td></tr>
              <tr><td className="text-muted">activation approval</td><td className="num text-right">{a.activationApprovalMin} min</td></tr>
              <tr><td className="text-muted">accept</td><td className="num text-right">{a.acceptMin} min</td></tr>
            </tbody>
          </table>
          <p className="mt-2 text-muted">{a.note}</p>
          <p className="mt-1 text-muted">The opener reads the same rewind report as /rewind; nothing is recomputed.</p>
        </div>
      )}
    </details>
  );
}

/** The opener body: shared by /opener and the /?opener=1 modal. */
export function OpenerContent({ data }: { readonly data: OpenerPageDTO }) {
  const o = data.opener;
  return (
    <section className="mx-auto w-full max-w-[1000px] px-4 py-8 text-left sm:px-8 sm:py-12" data-testid="opener">
      <div className="text-[13px] font-semibold uppercase tracking-wider text-muted">Lookahead · if it had been running today</div>
      {o === null ? (
        <p className="mt-6 text-[24px] leading-snug sm:text-[32px]" data-testid="opener-empty">
          {data.ready ? 'On this dataset, neither anticipation nor the reactive offer would have shortened a stroke consult wait. Nothing is claimed.' : 'The counterfactual replay is not available yet. Nothing is claimed rather than a guess.'}
        </p>
      ) : (
        <>
          <div className="mt-6 space-y-4">
            {openerSentences(o).map((s) => (
              <p key={s} className="text-[24px] leading-snug sm:text-[34px]" data-testid="opener-sentence">
                {s}
              </p>
            ))}
          </div>
          <Timeline o={o} />
        </>
      )}
      {data.impact !== null && (
        <p className="mt-8 text-[18px] sm:text-[22px]" data-testid="opener-impact">
          <span className="num font-semibold">{impactCounter(data.impact)}</span>{' '}
          <a href="/clinical-sources" className="text-accent underline">
            (estimate, see sources)
          </a>
        </p>
      )}
      <Assumptions a={data.assumptions} />
      <a href="/" className="mt-10 inline-block rounded bg-accent px-8 py-4 text-[20px] font-semibold text-bg" data-testid="opener-start">
        Start live demo
      </a>
    </section>
  );
}

/** /?opener=1: dismissible overlay over the Command Center (native dialog close, no client state). */
export function OpenerModal({ data }: { readonly data: OpenerPageDTO }) {
  return (
    <dialog open aria-label="Lookahead opener" className="fixed inset-0 z-50 m-0 h-screen max-h-none w-screen max-w-none overflow-y-auto border-0 bg-bg p-0 text-text" data-testid="opener-modal">
      <form method="dialog" className="sticky top-0 z-10 flex justify-end p-3">
        <button type="submit" className="rounded border border-border bg-panel px-4 py-2 text-[15px] text-text" data-testid="opener-close" aria-label="Close opener">
          Close
        </button>
      </form>
      <OpenerContent data={data} />
    </dialog>
  );
}
