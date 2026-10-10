import { applyCommand, decide, type ActContext, type ActionLog, type ActorRef, type Command, type CommandResult, type Dataset } from '../src';
import { dataset } from './detect.helpers';
import { et } from './helpers';

export { dataset };
export const COORD: ActorRef = { role: 'coordinator', id: 'coord-1' };
export const LEAD: ActorRef = { role: 'clinical_lead', id: 'lead-1' };
export const SYSTEM: ActorRef = { role: 'system', id: 'scheduler' };
export const phys = (id: string): ActorRef => ({ role: 'physician', id });

export const ctx: ActContext = { dataset };

/** Test-only fixture (brief hidden situation inverted): PHY-014 with 40 h worked, so two physicians are eligible. */
export const twoEligible: Dataset = { ...dataset, offShiftRoster: dataset.offShiftRoster.map((p) => (p.physicianId === 'PHY-014' ? { ...p, hoursWorkedLast7d: 40 } : p)) };

export function run(c: ActContext, log: ActionLog, cmd: Command, hms: string): CommandResult {
  return applyCommand(c, log, cmd, et(hms));
}

/** Applies a command that must succeed; returns the new log. */
export function must(c: ActContext, log: ActionLog, cmd: Command, hms: string): ActionLog {
  const r = run(c, log, cmd, hms);
  if (!r.ok) throw new Error(`${cmd.type} failed: ${r.code} ${r.message}`);
  return r.log;
}

export const offerIdOf = (log: ActionLog, physicianId: string): string => {
  const e = log.find((x) => x.type === 'offer_proposed' && x.payload.physicianId === physicianId);
  if (e?.type !== 'offer_proposed') throw new Error(`no offer for ${physicianId}`);
  return e.payload.offerId;
};

/** 18:21 propose, 18:22 approve (delivered). */
export function delivered(c: ActContext, physicianId: string, log: ActionLog = [], tag = ''): { log: ActionLog; offerId: string } {
  let l = must(c, log, { type: 'proposeOffer', commandId: `p-${physicianId}${tag}`, actor: COORD, physicianId }, '18:21:00');
  const offerId = offerIdOf(l, physicianId);
  l = must(c, l, { type: 'approveOffer', commandId: `a-${physicianId}${tag}`, actor: LEAD, offerId }, '18:22:00');
  return { log: l, offerId };
}

const d0 = decide(dataset, et('18:20:00'));
export const need1820 = (kind: string, hospitalId: string) => {
  const n = d0.needs.find((x) => x.kind === kind && x.hospitalId === hospitalId);
  if (n === undefined) throw new Error(`no ${kind} at ${hospitalId}`);
  return n;
};
