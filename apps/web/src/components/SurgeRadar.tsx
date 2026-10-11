'use client';

import type { HospitalForecastDTO, SurgeForecastDTO } from '@/lib/dto';
import { etHm } from '@/lib/format';
import { DeltaChip } from './DeltaChip';
import { Chip, cx, shortName } from './ui';
import type { Delta } from './useDelta';

/**
 * SURGE RADAR (Phase 7): hospitals ranked by the engine's riskRank, each with a
 * hand-written SVG over −180..+120 min: observed consults per 15 min (bars),
 * the trailing-60 count (line), the baseline per 15 min (dashed), the forecast
 * fan p10–p90 of cumulative new consults for the next 120 min, the spike
 * threshold (p90 of the hour) and P(spike) chips at +30/+60/+90/+120. Every
 * number is engine output (D-85); status words accompany every colour.
 */

const W = 560;
const H = 84;
const PAD = { l: 26, r: 8, t: 8, b: 16 };
const PAST_MIN = 180;
const FUTURE_MIN = 120;

const x = (minutesFromNow: number) => PAD.l + ((minutesFromNow + PAST_MIN) / (PAST_MIN + FUTURE_MIN)) * (W - PAD.l - PAD.r);

function pTone(p: number): { tone: 'critical' | 'warning' | 'muted'; word: string } {
  return p >= 0.6 ? { tone: 'critical', word: 'HIGH' } : p >= 0.3 ? { tone: 'warning', word: 'ELEVATED' } : { tone: 'muted', word: 'LOW' };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

function RadarRow({ h, bucketMin, deltas }: { readonly h: HospitalForecastDTO; readonly bucketMin: number; readonly deltas: ReadonlyMap<string, Delta> }) {
  const h60 = h.horizons.find((z) => z.minutes === 60);
  const lambda0 = h.drivers.find((d) => d.kind === 'baseline_hour')?.expected ?? 0;
  const basePer15 = lambda0 / 4;
  const future = h.checkpoints.filter((c) => c.minutesAhead <= FUTURE_MIN);
  // Trailing-60 count at each past bucket end (sum of the last four 15-min buckets).
  const trailing = h.past.map((b, i) => ({ minutesFromNow: (b.startMs + bucketMin * 60_000 - h.past[h.past.length - 1]!.startMs - bucketMin * 60_000) / 60_000, value: h.past.slice(Math.max(0, i - 3), i + 1).reduce((s, q) => s + q.count, 0), full: i >= 3 }));
  const yMax = Math.max(
    2,
    h.p90Now ?? 0,
    ...h.past.map((b) => b.count),
    ...trailing.map((t) => t.value),
    ...future.map((c) => c.expectedTrailing60),
    ...h.horizons.map((z) => z.p90),
    ...future.map((c) => c.p90 ?? 0),
  );
  const y = (v: number) => PAD.t + (1 - v / yMax) * (H - PAD.t - PAD.b);
  const barW = ((W - PAD.l - PAD.r) / (PAST_MIN + FUTURE_MIN)) * bucketMin - 2;
  const fan = h.horizons.filter((z) => z.minutes <= FUTURE_MIN);
  const fanPath = fan.length > 0 ? `M ${x(0)} ${y(0)} ${fan.map((z) => `L ${x(z.minutes)} ${y(z.p90)}`).join(' ')} ${[...fan].reverse().map((z) => `L ${x(z.minutes)} ${y(z.p10)}`).join(' ')} Z` : '';
  const p50Path = fan.length > 0 ? `M ${x(0)} ${y(0)} ${fan.map((z) => `L ${x(z.minutes)} ${y(z.p50)}`).join(' ')}` : '';
  const trailPath = trailing.filter((t) => t.full).map((t, i) => `${i === 0 ? 'M' : 'L'} ${x(t.minutesFromNow)} ${y(t.value)}`).join(' ');
  const expectPath = future.map((c, i) => `${i === 0 ? 'M' : 'L'} ${x(c.minutesAhead)} ${y(c.expectedTrailing60)}`).join(' ');
  const thresholdPath = h.p90Now === null ? '' : `M ${x(-PAST_MIN)} ${y(h.p90Now)} L ${x(0)} ${y(h.p90Now)} ${future.map((c) => `L ${x(c.minutesAhead)} ${y(c.p90 ?? h.p90Now ?? 0)}`).join(' ')}`;
  const chips = [30, 60, 90, 120].map((m) => ({ m, c: h.checkpoints.find((z) => z.minutesAhead === m) }));
  const desc = `${h.hospitalName}: ${h.observedLast60} consults in the last 60 min vs p90 ${h.p90Now ?? 'n/a'}; ${h.driverSentence}; P(spike) ${chips.map((z) => `+${z.m} ${pct(z.c?.pSpike ?? 0)}`).join(', ')}.`;
  const titleId = `radar-title-${h.hospitalId}`;
  const descId = `radar-desc-${h.hospitalId}`;
  return (
    <li data-testid="radar-row" data-hospital-id={h.hospitalId} data-risk-rank={h.riskRank} className="border-b border-border/70 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="num w-5 text-[12px] text-muted">#{h.riskRank}</span>
        <span className="text-[14px] font-semibold">{h.hospitalName}</span>
        <span className="num text-[11px] text-muted">{h.hospitalId}</span>
        {h.spikeNow ? <Chip tone="critical">SPIKE NOW</Chip> : <Chip tone="muted">QUIET</Chip>}
        <span className="num text-[12px] text-muted" title="consult_received in the trailing 60 min vs the hour's p90 (brief spike test)">
          observed <span className="text-text" data-testid="radar-observed">{h.observedLast60}</span>/60 min · p90 <span className="text-text">{h.p90Now ?? '–'}</span>
        </span>
        <DeltaChip d={deltas.get(`observed:${h.hospitalId}`)} />
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {chips.map(({ m, c }) => {
            const p = c?.pSpike ?? 0;
            const t = pTone(p);
            return (
              <span key={m} className="flex items-center gap-1">
                <Chip tone={t.tone} className="normal-case tracking-normal" title={`P(spike) at +${m} min: ${pct(p)} (${t.word}); expected trailing-60 ${c?.expectedTrailing60 ?? '–'} vs p90 ${c?.p90 ?? '–'}`}>
                  <span data-testid={`pspike-${m}`} data-value={p}>
                    +{m} {pct(p)}
                  </span>{' '}
                  <span className="text-[10px] uppercase">{t.word}</span>
                </Chip>
                {m === 60 && <DeltaChip d={deltas.get(`pspike60:${h.hospitalId}`)} digits={2} />}
              </span>
            );
          })}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-[84px] w-full" role="img" aria-labelledby={`${titleId} ${descId}`}>
        <title id={titleId}>{`Surge radar for ${h.hospitalName}`}</title>
        <desc id={descId}>{desc}</desc>
        {/* axes */}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--color-border)" />
        <line x1={x(0)} x2={x(0)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-accent)" strokeWidth={1.5} />
        {[-180, -120, -60, 0, 60, 120].map((m) => (
          <text key={m} x={x(m)} y={H - 4} textAnchor="middle" fontSize={9} fill="var(--color-muted)" fontFamily="var(--font-mono)">
            {m === 0 ? 'now' : `${m > 0 ? '+' : '−'}${Math.abs(m)}`}
          </text>
        ))}
        <text x={2} y={y(yMax) + 8} fontSize={9} fill="var(--color-muted)" fontFamily="var(--font-mono)">
          {yMax}
        </text>
        <text x={2} y={y(0)} fontSize={9} fill="var(--color-muted)" fontFamily="var(--font-mono)">
          0
        </text>
        {/* past bars: consults per 15 min */}
        {h.past.map((b, i) => {
          const m0 = -PAST_MIN + i * bucketMin;
          return <rect key={b.startMs} x={x(m0) + 1} width={Math.max(1, barW)} y={y(b.count)} height={Math.max(0, y(0) - y(b.count))} fill="var(--color-info)" fillOpacity={0.45} />;
        })}
        {/* baseline per 15 min */}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(basePer15)} y2={y(basePer15)} stroke="var(--color-muted)" strokeDasharray="3 3" />
        {/* forecast fan (cumulative new consults, p10–p90) and p50 */}
        {fanPath !== '' && <path d={fanPath} fill="var(--color-accent)" fillOpacity={0.18} stroke="none" />}
        {p50Path !== '' && <path d={p50Path} fill="none" stroke="var(--color-accent)" strokeWidth={1.2} />}
        {/* trailing-60 past and expected trailing-60 future */}
        {trailPath !== '' && <path d={trailPath} fill="none" stroke="var(--color-text)" strokeWidth={1.5} />}
        {expectPath !== '' && <path d={expectPath} fill="none" stroke="var(--color-text)" strokeWidth={1.2} strokeDasharray="4 2" />}
        {/* spike threshold p90 (per hour) */}
        {thresholdPath !== '' && <path d={thresholdPath} fill="none" stroke="var(--color-critical)" strokeWidth={1.2} />}
        {h.p90Now !== null && (
          <text x={W - PAD.r} y={y(h.p90Now) - 2} textAnchor="end" fontSize={9} fill="var(--color-critical)" fontFamily="var(--font-mono)">
            p90 {h.p90Now}
          </text>
        )}
      </svg>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-muted">
        <span>{h.driverSentence}</span>
        {h60 !== undefined && (
          <span className="num ml-auto" title="60-min forecast: p10 / p50 / p90 of new consults; stroke share applied for the stroke expectation">
            next 60: p10 {h60.p10} · p50 {h60.p50} · p90 {h60.p90} · stroke {h60.expectedStroke}
          </span>
        )}
      </div>
    </li>
  );
}

export function SurgeRadar({ forecast, deltas, limit }: { readonly forecast: SurgeForecastDTO | undefined; readonly deltas: ReadonlyMap<string, Delta>; readonly limit?: number }) {
  if (forecast === undefined) return <p className="p-3 text-muted">Forecast not available in this view.</p>;
  if (forecast.hospitals.length === 0) return <p className="p-3 text-muted">No hospitals in the dataset: nothing to forecast.</p>;
  const rows = [...forecast.hospitals].sort((a, b) => a.riskRank - b.riskRank).slice(0, limit ?? forecast.hospitals.length);
  return (
    <div data-testid="surge-radar">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-[11px] text-muted">
        <span className="font-semibold uppercase tracking-wider">Legend</span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 bg-info/50" /> consults / 15 min
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-text" /> trailing 60 (dashed: expected)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-critical" /> p90 spike threshold
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 bg-accent/30" /> fan p10–p90 cumulative, +120
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 border-t border-dashed border-muted" /> baseline / 15 min
        </span>
        <span className={cx('num ml-auto')} title="Hawkes fit shared by every hospital (D-85)">
          fit η {forecast.params.eta} · half-life {forecast.params.halfLifeMin} min · m_net {forecast.params.mNet} · {forecast.params.fitArrivals} arrivals · as of {etHm(forecast.asOfMs)}
        </span>
      </div>
      <ul>
        {rows.map((h) => (
          <RadarRow key={h.hospitalId} h={h} bucketMin={forecast.pastBucketMin} deltas={deltas} />
        ))}
      </ul>
      {limit !== undefined && forecast.hospitals.length > limit && (
        <p className="px-3 py-1.5 text-[11px] text-muted">
          {forecast.hospitals.length - limit} lower-risk hospital(s) hidden: {forecast.hospitals.filter((h) => h.riskRank > limit).map((h) => shortName(h.hospitalName)).join(', ')}
        </p>
      )}
    </div>
  );
}
