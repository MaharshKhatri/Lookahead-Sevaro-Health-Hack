'use client';

import type { ViewDTO } from '@/lib/dto';
import type { BacktestReport } from '@/server/quality';
import { etHm } from '@/lib/format';
import { LiveProvider } from './live';
import { TopBar } from './TopBar';
import { Panel } from './ui';

/**
 * /quality (Phase 3, D-89): the forecast backtest table, the 5-bin
 * reliability chart (hand-written SVG), the first-warning lead times and the
 * limitations box. Every number comes from docs/forecast_backtest.json.
 */

const MODEL_LABEL: Readonly<Record<string, string>> = { M0: 'M0 baseline Poisson', M1: 'M1 persistence Poisson', M2: 'M2 Lookahead' };
const COLORS = ['var(--color-muted)', 'var(--color-warning)', 'var(--color-accent)'];

function Reliability({ r }: { readonly r: BacktestReport }) {
  const W = 360;
  const H = 240;
  const P = 36;
  const x = (v: number) => P + v * (W - 2 * P);
  const y = (v: number) => H - P - v * (H - 2 * P);
  const models = Object.keys(r.reliability);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]" role="img" aria-labelledby="rel-title rel-desc" data-testid="reliability-chart">
      <title id="rel-title">Reliability of the spike probability at origin + 60 min</title>
      <desc id="rel-desc">{models.map((m) => `${m}: ${r.reliability[m]?.map((b) => `predicted ${b.meanPredicted} observed ${b.observed} (n ${b.n})`).join(', ')}`).join('; ')}</desc>
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--color-border)" strokeDasharray="4 3" />
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(0)} stroke="var(--color-border)" />
      <line x1={x(0)} y1={y(0)} x2={x(0)} y2={y(1)} stroke="var(--color-border)" />
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <text x={x(v)} y={H - P + 14} textAnchor="middle" fontSize={10} fill="var(--color-muted)" className="num">{v}</text>
          <text x={x(0) - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill="var(--color-muted)" className="num">{v}</text>
        </g>
      ))}
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--color-muted)">mean predicted probability</text>
      {models.map((m, i) => {
        const bins = (r.reliability[m] ?? []).filter((b) => b.n > 0);
        return (
          <g key={m}>
            <path d={bins.map((b, j) => `${j === 0 ? 'M' : 'L'} ${x(b.meanPredicted)} ${y(b.observed)}`).join(' ')} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth={2} />
            {bins.map((b) => (
              <circle key={`${m}-${b.lo}`} cx={x(b.meanPredicted)} cy={y(b.observed)} r={3 + Math.min(5, Math.log10(Math.max(1, b.n)))} fill={COLORS[i % COLORS.length]} fillOpacity={0.8}>
                <title>{`${m} bin [${b.lo}, ${b.hi}): predicted ${b.meanPredicted}, observed ${b.observed}, n ${b.n}`}</title>
              </circle>
            ))}
            <text x={x(0) + 4} y={P - 4 + i * 12} fontSize={10} fill={COLORS[i % COLORS.length]}>■ {MODEL_LABEL[m] ?? m}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Body({ report }: { readonly report: BacktestReport | null }) {
  if (report === null) {
    return (
      <main className="p-6" data-testid="quality-missing">
        <Panel title="Forecast quality"><p className="p-4 text-muted">docs/forecast_backtest.json is missing. Run <code className="num">pnpm report:forecast</code> to generate it; nothing is shown rather than a guess.</p></Panel>
      </main>
    );
  }
  const models = Object.keys(report.metrics);
  const fw = report.firstWarning;
  return (
    <main className="scroll-thin flex-1 space-y-3 overflow-y-auto p-3" data-testid="quality" tabIndex={0} aria-label="Forecast quality">
      <Panel title={<>FORECAST QUALITY <span className="normal-case tracking-normal text-text">— rolling-origin backtest, honest by construction</span></>} right={<span className="num text-[12px] text-muted">{report.design.originCount} origins · {report.design.pairCount} (origin, hospital) pairs · {report.dataset.label}</span>}>
        <table className="w-full text-left text-[14px]" data-testid="quality-table">
          <thead className="text-[12px] uppercase tracking-wider text-muted">
            <tr>
              <th className="px-3 py-2">model</th>
              <th className="px-3 py-2 text-right">MAE</th>
              <th className="px-3 py-2 text-right">mean log score</th>
              <th className="px-3 py-2 text-right">RPS</th>
              <th className="px-3 py-2 text-right">80% coverage</th>
              <th className="px-3 py-2 text-right">Brier (spike +60)</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => {
              const x = report.metrics[m];
              if (x === undefined) return null;
              return (
                <tr key={m} className="border-t border-border" data-testid="quality-model-row">
                  <td className="px-3 py-2 font-semibold">{MODEL_LABEL[m] ?? m}</td>
                  <td className="num px-3 py-2 text-right">{x.mae.toFixed(3)}</td>
                  <td className="num px-3 py-2 text-right">{x.logScore.toFixed(3)}</td>
                  <td className="num px-3 py-2 text-right">{x.rps.toFixed(3)}</td>
                  <td className="num px-3 py-2 text-right">{x.coverage80.toFixed(3)}</td>
                  <td className="num px-3 py-2 text-right">{x.brier.toFixed(4)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t border-border p-3 text-[13px] text-muted">
          {report.skill.map((s) => (
            <div key={s.vs}>
              Skill of M2 vs {s.vs}: MAE <span className="num text-text">{s.mae.toFixed(3)}</span> · RPS <span className="num text-text">{s.rps.toFixed(3)}</span> · Brier <span className="num text-text">{s.brier.toFixed(3)}</span> · log score <span className="num text-text">{s.logScore.toFixed(3)}</span> (positive = M2 better)
            </div>
          ))}
        </div>
      </Panel>
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
        <Panel title="Reliability (spike at origin + 60 min)" testId="quality-reliability">
          <div className="p-3">
            <Reliability r={report} />
            <p className="mt-2 text-[12px] text-muted">Dot size grows with n. A calibrated model lies on the diagonal. Realized spikes: a 1–2 consult exceedance of p90 thresholds of 1–3 on this synthetic day.</p>
          </div>
        </Panel>
        <Panel title="First warning" testId="quality-first-warning">
          <div className="p-3 text-[14px]">
            <p>
              <span className="num font-semibold text-text">{fw.n}</span> realized spike onsets; <span className="num text-text">{fw.nWithOriginBefore}</span> had an origin before them; <span className="num text-text">{fw.nWarned}</span> warned at P ≥ {report.design.warningThreshold} (<span className="num text-text">{fw.nWarnedLead60Plus}</span> with ≥ 60 min lead); median lead <span className="num text-text">{fw.medianLeadMin ?? '—'}</span> min.
            </p>
            <table className="mt-2 w-full text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-wider text-muted">
                <tr><th className="py-1">hospital</th><th className="py-1">onset</th><th className="py-1 text-right">count / p90</th><th className="py-1 text-right">lead (min)</th></tr>
              </thead>
              <tbody>
                {fw.onsets.map((o) => (
                  <tr key={`${o.hospitalId}|${o.onsetMs}`} className="border-t border-border">
                    <td className="py-1">{report.dataset.hospitalNames[o.hospitalId] ?? o.hospitalId}</td>
                    <td className="num py-1">{etHm(o.onsetMs)}</td>
                    <td className="num py-1 text-right">{o.countAtOnset} / {o.p90}</td>
                    <td className="num py-1 text-right">{o.leadMin ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[12px] text-muted">Small sample: one synthetic day. Leads under 60 min are partly mechanical (part of the onset window is already known at the origin).</p>
          </div>
        </Panel>
      </div>
      <Panel title="Limitations" testId="quality-limitations">
        <ul className="space-y-1 p-3 text-[14px] text-muted">
          <li>· One synthetic day: the spikes are 1–2 consult exceedances of p90 thresholds of 1–3, so count metrics barely separate the models; M2 beats persistence (M1) but not the baseline-only M0 on count metrics here, and that is reported as it fell.</li>
          <li>· Production would fit on Sevaro's history: the baseline file is itself a 12-week aggregate, and the day-rate and Hawkes terms need many days to earn their keep.</li>
          <li>· Why this model class: calibrated with little data (empirical-Bayes priors), explainable per driver (baseline · today's rate · recent arrivals), cheap (closed forms, grid fit under 100 ms) and robust (no gradient fitting, no black box).</li>
          <li>· Where it is weak: the half-life is weakly identified, excitation counts the first generation only, hour buckets are coarse, and the deterministic +1 hold of the brief's spike rule is not aged out.</li>
          <li>· Leakage check: forecasts at {report.leakage.checks.length} origins are {report.leakage.allIdentical ? 'byte-identical' : 'NOT identical'} with and without events ingested after the origin.</li>
        </ul>
      </Panel>
    </main>
  );
}

export function QualityView({ initial, report }: { readonly initial: ViewDTO | null; readonly report: BacktestReport | null }) {
  return (
    <LiveProvider initial={initial}>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <Body report={report} />
      </div>
    </LiveProvider>
  );
}
