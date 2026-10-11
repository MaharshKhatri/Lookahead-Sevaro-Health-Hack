'use client';

import { useState } from 'react';
import { scenario } from '@/content/facts';

/**
 * The hero "Horizon replay": the real 18:20 evening from the challenge data,
 * drawn once on load (about 6 s) with CSS animations, so it also plays
 * without JavaScript. The only client code remounts the SVG for Replay.
 * prefers-reduced-motion shows the final state at once (globals.css).
 */

const START = 18 * 60 + 5; // 18:05
const END = 21 * 60; // 21:00
const W = 1200;
const H = 284;
const X0 = 24;
const X1 = W - 24;
const AXIS = 246;
const LANE_OAK = 66;
const LANE_SUN = 138;
const LANE_NET = 196;

const toMin = (hms: string) => {
  const [h = '0', m = '0', s = '0'] = hms.split(':');
  return Number(h) * 60 + Number(m) + Number(s) / 60;
};
const x = (hms: string) => X0 + ((toMin(hms) - START) / (END - START)) * (X1 - X0);
const d = (s: number) => ({ animationDelay: `${s}s` });

const NOW = x(scenario.now);
const TICKS = ['18:30', '19:00', '19:30', '20:00', '20:30', '21:00'];

function Diamond({ cx, cy, delay }: { readonly cx: number; readonly cy: number; readonly delay: number }) {
  return <path className="hz-step" style={d(delay)} d={`M${cx} ${cy - 8} L${cx + 8} ${cy} L${cx} ${cy + 8} L${cx - 8} ${cy} Z`} fill="var(--color-alarm)" />;
}

function FailTick({ cx, cy, delay }: { readonly cx: number; readonly cy: number; readonly delay: number }) {
  return <path className="hz-step" style={d(delay)} d={`M${cx - 4} ${cy + 12} L${cx + 4} ${cy + 20} M${cx + 4} ${cy + 12} L${cx - 4} ${cy + 20}`} stroke="var(--color-alarm)" strokeWidth="2" />;
}

function beats(): string[] {
  const oak = scenario.oakValley;
  const sun = scenario.suncrest;
  const rec = scenario.recommendation;
  return [
    `${oak.triaged.slice(0, 5)}: a stroke consult is triaged at ${oak.hospital}; routing fails at ${oak.routingFailures.map((t) => t.slice(0, 5)).join(', ')} because ${oak.why}.`,
    `${sun.hospital}: ${sun.lastHourConsults} consults in the last hour against a normal p90 of ${sun.normalP90}; a stroke consult triaged at ${sun.strokeTriaged.slice(0, 5)} fails routing at ${sun.routingFailure.slice(0, 5)}.`,
    `${scenario.shiftEnds.at}: ${scenario.shiftEnds.physicians} physicians end their shifts ${scenario.shiftEnds.note}.`,
    `${scenario.now}: Lookahead recommends offering ${rec.shortName} ${rec.window}; the clinical lead approves.`,
    `From ${rec.start}, ${rec.shortName} is online and ${rec.effect}.`,
  ];
}

function Figure() {
  const oak = scenario.oakValley;
  const sun = scenario.suncrest;
  const rec = scenario.recommendation;
  const onlineX = x(rec.start);
  const summary = beats().join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[760px]" role="img" aria-labelledby="hz-title hz-desc">
      <title id="hz-title">Horizon replay of the evening of {scenario.date}, 18:05 to 21:00 ET</title>
      <desc id="hz-desc">{summary}</desc>
      <defs>
        <pattern id="hz-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" stroke="var(--color-caution)" strokeWidth="2.4" />
        </pattern>
      </defs>

      {/* the past (faint) and "now" */}
      <rect x={X0} y={20} width={NOW - X0} height={AXIS - 20} fill="var(--color-raised)" opacity="0.5" />
      <line x1={NOW} x2={NOW} y1={14} y2={AXIS + 6} stroke="var(--color-ink)" strokeWidth="1.5" />
      <text x={NOW + 6} y={16} fontSize="13" fill="var(--color-ink)" className="font-mono">
        now {scenario.now}
      </text>

      {/* axis: past in rule grey, future in teal (the Horizon Line) */}
      <line x1={X0} x2={NOW} y1={AXIS} y2={AXIS} stroke="var(--color-rule)" strokeWidth="2" />
      <line x1={NOW} x2={X1} y1={AXIS} y2={AXIS} stroke="var(--color-action)" strokeWidth="2" opacity="0.55" />
      {TICKS.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={AXIS - 4} y2={AXIS + 4} stroke="var(--color-ink-3)" />
          <text x={x(t)} y={AXIS + 26} textAnchor="middle" fontSize="13" fill="var(--color-ink-2)" className="font-mono">
            {t}
          </text>
        </g>
      ))}

      {/* 1. Oak Valley: stroke triaged, routing fails three times */}
      <text x={NOW + 12} y={LANE_OAK - 18} fontSize="13" fill="var(--color-ink-2)">
        {oak.hospital}
      </text>
      <line className="hz-step" style={d(0.3)} x1={x(oak.triaged)} x2={NOW} y1={LANE_OAK} y2={LANE_OAK} stroke="var(--color-alarm)" strokeWidth="4" />
      <Diamond cx={x(oak.triaged)} cy={LANE_OAK} delay={0.2} />
      {oak.routingFailures.map((t, i) => (
        <FailTick key={t} cx={x(t)} cy={LANE_OAK} delay={0.6 + i * 0.35} />
      ))}
      <text className="hz-step" style={d(1.5)} x={NOW + 12} y={LANE_OAK + 5} fontSize="15" fill="var(--color-ink)">
        Stroke consult waiting since {oak.triaged.slice(0, 5)}. Routing failed at {oak.routingFailures.map((t) => t.slice(0, 5)).join(', ')}: {oak.why}.
      </text>

      {/* 2. Suncrest surge (hatched = at risk) and its stroke consult */}
      <text x={NOW + 12} y={LANE_SUN - 18} fontSize="13" fill="var(--color-ink-2)">
        {sun.hospital}
      </text>
      <rect className="hz-step" style={d(2.1)} x={X0} y={LANE_SUN - 9} width={NOW - X0} height={18} fill="url(#hz-hatch)" />
      <Diamond cx={x(sun.strokeTriaged)} cy={LANE_SUN} delay={2.4} />
      <FailTick cx={x(sun.routingFailure)} cy={LANE_SUN} delay={2.6} />
      <text className="hz-step" style={d(2.5)} x={NOW + 12} y={LANE_SUN + 5} fontSize="15" fill="var(--color-ink)">
        Surge: {sun.lastHourConsults} consults in the last hour, normal is {sun.normalP90}. A stroke consult fails routing at {sun.routingFailure.slice(0, 5)}.
      </text>

      {/* 3. 19:00 shift ends */}
      <g className="hz-step" style={d(3.2)}>
        <path d={`M${x(scenario.shiftEnds.at) - 6} ${LANE_NET - 14} L${x(scenario.shiftEnds.at)} ${LANE_NET - 14} L${x(scenario.shiftEnds.at)} ${LANE_NET + 6} L${x(scenario.shiftEnds.at) - 6} ${LANE_NET + 6}`} fill="none" stroke="var(--color-caution)" strokeWidth="2.5" />
        <text x={x(scenario.shiftEnds.at) + 10} y={LANE_NET - 2} fontSize="15" fill="var(--color-ink)">
          −{scenario.shiftEnds.physicians} physicians at {scenario.shiftEnds.at}, with open consults and notes
        </text>
      </g>

      {/* 4. Lookahead's recommendation at now (teal flag) */}
      <g className="hz-step" style={d(4.0)}>
        <line x1={NOW} x2={NOW} y1={AXIS} y2={AXIS - 34} stroke="var(--color-action)" strokeWidth="2.5" />
        <path d={`M${NOW} ${AXIS - 34} L${NOW + 14} ${AXIS - 29} L${NOW} ${AXIS - 24} Z`} fill="var(--color-action)" />
        <text x={NOW + 20} y={AXIS - 24} fontSize="15" fontWeight="600" fill="var(--color-action)">
          Lookahead: offer {rec.shortName} {rec.window}, clinical lead approves
        </text>
      </g>

      {/* 5. online from 18:35: both deadlocks end */}
      <line className="hz-draw" style={d(4.8)} pathLength={1} x1={onlineX} x2={X1} y1={AXIS} y2={AXIS} stroke="var(--color-action)" strokeWidth="5" />
      <text className="hz-step" style={d(5.6)} x={x('19:50')} y={AXIS - 10} fontSize="15" fill="var(--color-action)">
        Online from {rec.start}: both stroke deadlocks end within 15 min
      </text>
    </svg>
  );
}

export function HorizonReplay() {
  const [run, setRun] = useState(0);
  return (
    <figure className="relative">
      {/* at most one very faint teal haze behind the hero visual */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-[10%] top-1/4 -z-10 h-1/2 rounded-full bg-action opacity-[0.05] blur-3xl" />
      <div className="overflow-x-auto rounded-[4px] border border-rule bg-surface px-2 py-4">
        <Figure key={run} />
      </div>
      <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-[15px] text-ink-2 marker:text-ink-2 sm:hidden">
        {beats().map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ol>
      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[15px] text-ink-2">
        <span>A real evening from Sevaro&apos;s challenge data, replayed.</span>
        <button type="button" onClick={() => setRun((r) => r + 1)} className="rounded-[4px] border border-rule px-3 py-1.5 text-[15px] text-ink hover:border-ink-3">
          Replay
        </button>
      </figcaption>
    </figure>
  );
}
