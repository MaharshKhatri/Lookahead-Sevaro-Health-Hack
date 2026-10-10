'use client';

import type { ConsultRowDTO, PhysicianRowDTO, ViewDTO } from '@/lib/dto';
import { etHm, etHms } from '@/lib/format';
import { LiveProvider, useLive } from './live';
import { TopBar } from './TopBar';
import { Chip, EvidenceChip, Panel, cx } from './ui';

/**
 * /state: physician activity and consult lifecycle as two independent models
 * (brief "Physician state and consult state are separate"; "Show physician
 * activity and the consult lifecycle independently, with time in stage
 * measured against the standards").
 */

const STATE_TONE: Record<string, string> = {
  'Incoming Hospital Call': 'text-warning',
  'Outgoing Hospital Call': 'text-warning',
  'Video Consult In Progress': 'text-warning',
  'Camera Active - No Synapse Session': 'text-critical',
  'Temporarily Unavailable': 'text-critical',
  'Documentation / Note': 'text-info',
  'In Meeting': 'text-info',
  Available: 'text-ok',
};

function Physicians({ rows }: { readonly rows: readonly PhysicianRowDTO[] }) {
  return (
    <Panel testId="panel-physicians" title="Physicians — derived activity" right={<span className="text-[12px] text-muted">self-reported status is not activity</span>}>
      <div className="scroll-thin overflow-auto">
        <table className="w-full text-left text-[14px]">
          <thead className="sticky top-0 bg-panel text-[11px] uppercase tracking-wider text-muted">
            <tr>
              {['Physician', 'Shift', 'Derived state', 'Self-reported', 'Agent', 'Cons.', 'Calls', 'Open', 'Min to end', 'Flags (because)'].map((h) => (
                <th key={h} className="border-b border-border px-2 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.physicianId} className="align-top" data-testid="physician-row">
                <td className="border-b border-border/60 px-2 py-2">
                  <div className="font-semibold">{p.name}</div>
                  <div className="num text-[12px] text-muted">{p.physicianId}</div>
                </td>
                <td className="num whitespace-nowrap border-b border-border/60 px-2 py-2 text-muted">{p.shift}</td>
                <td className="border-b border-border/60 px-2 py-2">
                  <div className={cx('font-semibold', STATE_TONE[p.derivedState] ?? 'text-text')}>{p.derivedState}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.derivedBecause.slice(0, 2).map((e) => (
                      <EvidenceChip key={e.eventId} e={e} />
                    ))}
                  </div>
                </td>
                <td className="border-b border-border/60 px-2 py-2 text-muted">{p.selfReported}</td>
                <td className="border-b border-border/60 px-2 py-2">{p.agent === 'Online' ? <Chip tone="ok">ONLINE</Chip> : <Chip tone="warning">OFFLINE</Chip>}</td>
                <td className="num border-b border-border/60 px-2 py-2">{p.consults}</td>
                <td className="num border-b border-border/60 px-2 py-2">{p.calls}</td>
                <td className="num border-b border-border/60 px-2 py-2">
                  {p.open}
                  {p.openConsultIds.length > 0 && <div className="flex max-w-[150px] flex-wrap gap-x-1.5 text-[11px] text-muted">{p.openConsultIds.map((id) => <span key={id} className="whitespace-nowrap">{id}</span>)}</div>}
                </td>
                <td className={cx('num border-b border-border/60 px-2 py-2', Number(p.minToEnd) <= 60 ? 'font-semibold text-warning' : '')}>{p.minToEnd}</td>
                <td className="border-b border-border/60 px-2 py-2">
                  <div className="flex flex-col gap-1.5">
                    {p.flags.map((f) => (
                      <div key={f.code} title={f.detail}>
                        <Chip tone={f.code === 'IN_MEETING_INTERRUPTIBLE' ? 'info' : f.code === 'AGENT_OFFLINE_UNVERIFIED' || f.code === 'RINGING_UNANSWERED' ? 'warning' : 'critical'}>{f.label}</Chip>
                        <div className="mt-0.5 text-[12px] text-muted">{f.detail}</div>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {f.because.map((e) => (
                            <EvidenceChip key={e.eventId} e={e} />
                          ))}
                        </div>
                      </div>
                    ))}
                    {p.flags.length === 0 && <span className="text-[12px] text-muted">none</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

const LEVEL_TONE = { ok: 'ok', warning: 'warning', critical: 'critical' } as const;

function Consults({ rows }: { readonly rows: readonly ConsultRowDTO[] }) {
  return (
    <Panel testId="panel-consults" title="Consults — lifecycle and time in stage" right={<span className="text-[12px] text-muted">brief Operational Standards</span>}>
      <div className="scroll-thin overflow-auto">
        <table className="w-full text-left text-[14px]">
          <thead className="sticky top-0 bg-panel text-[11px] uppercase tracking-wider text-muted">
            <tr>
              {['Consult', 'Hospital', 'Type', 'Stage', 'Entered', 'Min in stage', 'Since rcvd', 'Standard', 'Assigned'].map((h) => (
                <th key={h} className="border-b border-border px-2 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.consultId} className="align-top" data-testid="consult-row">
                <td className="num whitespace-nowrap border-b border-border/60 px-2 py-2 font-semibold">{c.consultId}</td>
                <td className="border-b border-border/60 px-2 py-2">
                  {c.hospitalName}
                  <div className="num text-[11px] text-muted">{c.hospitalId}</div>
                </td>
                <td className="border-b border-border/60 px-2 py-2">{c.type === 'Stroke' ? <Chip tone="critical">STROKE</Chip> : <span className="text-muted">{c.type}</span>}</td>
                <td className="border-b border-border/60 px-2 py-2">{c.stage}</td>
                <td className="num border-b border-border/60 px-2 py-2 text-muted">{c.enteredMs === null ? '-' : etHms(c.enteredMs)}</td>
                <td className="num border-b border-border/60 px-2 py-2">{c.minInStage ?? '-'}</td>
                <td className="num border-b border-border/60 px-2 py-2 text-muted">{c.minSinceReceived ?? '-'}</td>
                <td className="border-b border-border/60 px-2 py-2">
                  {c.standard === null ? (
                    <span className="text-[12px] text-muted">no standard for this stage</span>
                  ) : (
                    <div title={`${c.standard.label}: warning at ${etHm(c.standard.warnAtMs)}, critical at ${etHm(c.standard.criticalAtMs)} ET`}>
                      <Chip tone={LEVEL_TONE[c.standard.level]}>{c.standard.level.toUpperCase()}</Chip>
                      <div className="mt-0.5 text-[12px] text-muted">
                        <span className="num text-text">{c.standard.elapsedMin}</span> min · warn {etHm(c.standard.warnAtMs)} · crit {etHm(c.standard.criticalAtMs)}
                      </div>
                    </div>
                  )}
                </td>
                <td className="num whitespace-nowrap border-b border-border/60 px-2 py-2">{c.assigned ?? <span className="text-critical">Unassigned</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Body() {
  const { view } = useLive();
  if (view === null) return <p className="p-8 text-muted">Loading…</p>;
  return (
    <main className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-3">
      <Physicians rows={view.physicians} />
      <Consults rows={view.consults} />
    </main>
  );
}

export function StateView({ initial }: { readonly initial: ViewDTO | null }) {
  return (
    <LiveProvider initial={initial}>
      <div className="flex h-screen flex-col overflow-hidden">
        <TopBar />
        <Body />
      </div>
    </LiveProvider>
  );
}
