/** Hand-built architecture diagram for /integration (no diagram library). Teal marks Lookahead itself. */

const W = 1120;
const H = 470;

interface BoxProps {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
  readonly lines: readonly string[];
  readonly accent?: boolean;
  readonly dashed?: boolean;
}

function Box({ x, y, w, h, title, lines, accent = false, dashed = false }: BoxProps) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={4} fill="var(--color-surface)" stroke={accent ? 'var(--color-action)' : 'var(--color-rule)'} strokeWidth={accent ? 2 : 1.5} strokeDasharray={dashed ? '5 4' : undefined} />
      <text x={x + 14} y={y + 26} fontSize="16" fontWeight="600" fill={accent ? 'var(--color-action)' : 'var(--color-ink)'}>
        {title}
      </text>
      {lines.map((l, i) => (
        <text key={l} x={x + 14} y={y + 50 + i * 20} fontSize="14" fill="var(--color-ink-2)">
          {l}
        </text>
      ))}
    </g>
  );
}

function Arrow({ d }: { readonly d: string }) {
  return <path d={d} fill="none" stroke="var(--color-ink-3)" strokeWidth="1.6" markerEnd="url(#arrow)" />;
}

export function ArchitectureDiagram() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[820px]" role="img" aria-labelledby="arch-t arch-d">
      <title id="arch-t">Lookahead architecture</title>
      <desc id="arch-d">
        Event sources such as a Synapse-style event feed or a CSV package send events to a signed event API. The Lookahead engine replays them and detects, forecasts and decides. The coordinator command center proposes, the clinical lead approves, and the physician answers an offer on the phone. Outbound webhooks notify existing tools. On AWS, EC2 runs the app, DynamoDB stores the action log with atomic offer acceptance, Bedrock only narrates, and S3 archives the audit trail.
      </desc>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" fill="var(--color-ink-3)" />
        </marker>
      </defs>

      <Box x={10} y={30} w={200} h={110} title="Event sources" lines={['Synapse-style event feed', 'CSV data package']} />
      <Box x={250} y={30} w={200} h={110} title="Signed event API" lines={['HMAC-signed body', 'idempotent on event ID']} />
      <Box x={490} y={20} w={250} h={130} title="Lookahead engine" lines={['replay in knowledge time', 'detect, forecast', 'decide: eligibility, trap']} accent />
      <Box x={790} y={30} w={320} h={110} title="Outbound webhooks" lines={['signed store-change envelope', 'to existing tools, plus a read API']} />

      <Box x={490} y={200} w={250} h={90} title="Coordinator console" lines={['proposes the intervention']} />
      <Box x={790} y={200} w={320} h={90} title="Clinical lead approval" lines={['approves the exact message (PIN)']} />
      <Box x={790} y={320} w={320} h={60} title="Physician phone offer" lines={[]} />
      <text x={804} y={366} fontSize="14" fill="var(--color-ink-2)">
        accepts or declines; 10-minute expiry
      </text>

      <Arrow d="M210 85 L246 85" />
      <Arrow d="M450 85 L486 85" />
      <Arrow d="M740 85 L786 85" />
      <Arrow d="M615 150 L615 196" />
      <Arrow d="M740 245 L786 245" />
      <Arrow d="M950 290 L950 316" />

      {/* AWS layer */}
      <line x1={10} x2={W - 10} y1={404} y2={404} stroke="var(--color-rule)" strokeDasharray="4 4" />
      <text x={10} y={398} fontSize="13" fill="var(--color-ink-2)">
        Runs on AWS (every service degrades to a local fallback)
      </text>
      {[
        { x: 10, t: 'EC2', s: 'runs the app' },
        { x: 290, t: 'DynamoDB', s: 'action log, atomic offer acceptance' },
        { x: 570, t: 'Bedrock', s: 'narration only, behind a guard' },
        { x: 850, t: 'S3', s: 'audit archive' },
      ].map((b) => (
        <g key={b.t}>
          <rect x={b.x} y={414} width={260} height={46} rx={4} fill="var(--color-ground)" stroke="var(--color-rule)" strokeDasharray="5 4" />
          <text x={b.x + 12} y={442} fontSize="14" fill="var(--color-ink)">
            <tspan fontWeight="600">{b.t}</tspan>
            <tspan fill="var(--color-ink-2)"> {b.s}</tspan>
          </text>
        </g>
      ))}
    </svg>
  );
}
