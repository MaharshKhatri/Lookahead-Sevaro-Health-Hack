import 'server-only';
import { randomUUID } from 'node:crypto';
import { findPhiViolations, type ActorRef, type Command, type CommandType } from '@lookahead/engine';
import type { UiRole } from '@/lib/dto';
import { StoreError } from './store';

/**
 * POST /api/commands body -> engine Command. The actor always comes from the
 * x-lookahead-role / x-lookahead-actor-id headers (brief "Users and Decision
 * Rights"); the engine's COMMAND_ROLES decides what each role may do. This
 * only checks shapes so a malformed body is a 400, not an engine crash.
 */

export const UI_ROLES: readonly UiRole[] = ['coordinator', 'clinical_lead', 'physician'];
const DEFAULT_ACTOR_ID: Readonly<Record<UiRole, string>> = { coordinator: 'coordinator-on-duty', clinical_lead: 'clinical-lead-on-duty', physician: '' };

type Shape = Readonly<Record<string, 'string' | 'string?' | 'strings?' | 'number?' | 'boolean?' | 'object' | 'response' | 'standbyResponse' | 'activationResponse'>>;

const SHAPES: Readonly<Record<CommandType, Shape>> = {
  proposeOffer: { physicianId: 'string', needIds: 'strings?', slotId: 'string?' },
  proposeSlot: { needIds: 'strings?', k: 'number?' },
  approveOffer: { offerId: 'string', note: 'string?' },
  rejectOffer: { offerId: 'string', reason: 'string?' },
  respond: { offerId: 'string', physicianId: 'string?', response: 'response' },
  cancelOffer: { offerId: 'string', reason: 'string' },
  tick: {},
  raiseEscalation: { subject: 'object', reason: 'string' },
  authorizeEscalation: { escalationId: 'string', note: 'string?' },
  requestReassignment: { consultId: 'string', toPhysicianId: 'string' },
  sendInternalAlert: { message: 'string', physicianIds: 'strings?' },
  // Standby network (Phase 4).
  proposeStandby: { physicianId: 'string' },
  approveStandby: { standbyId: 'string', note: 'string?' },
  rejectStandby: { standbyId: 'string', reason: 'string?' },
  respondStandby: { standbyId: 'string', physicianId: 'string?', response: 'standbyResponse' },
  proposeActivation: { standbyId: 'string', force: 'boolean?', reason: 'string?' },
  approveActivation: { standbyId: 'string', note: 'string?' },
  rejectActivation: { standbyId: 'string', reason: 'string?' },
  respondActivation: { standbyId: 'string', physicianId: 'string?', response: 'activationResponse' },
  releaseStandby: { standbyId: 'string', reason: 'string?' },
  cancelStandby: { standbyId: 'string', reason: 'string' },
};

const bad = (message: string) => new StoreError('BAD_REQUEST', message);

export function actorFrom(headers: Headers): ActorRef {
  const role = headers.get('x-lookahead-role')?.trim() ?? '';
  if (role === 'system') throw new StoreError('FORBIDDEN_ROLE', 'role "system" is reserved for the server (internal alerts and clock ticks)');
  if (!UI_ROLES.includes(role as UiRole)) throw bad(`x-lookahead-role must be one of ${UI_ROLES.join(', ')}`);
  const id = headers.get('x-lookahead-actor-id')?.trim() || DEFAULT_ACTOR_ID[role as UiRole];
  if (id === '') throw bad('x-lookahead-actor-id is required for the physician role (the offer\'s physician id)');
  return { role: role as UiRole, id };
}

export function parseCommand(body: Record<string, unknown>, actor: ActorRef): Command {
  const raw = body.command;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('body.command must be an object');
  const c = raw as Record<string, unknown>;
  const type = c.type;
  if (typeof type !== 'string' || !(type in SHAPES)) throw bad(`unknown command type ${JSON.stringify(type)} (one of ${Object.keys(SHAPES).join(', ')})`);
  const shape = SHAPES[type as CommandType];
  const out: Record<string, unknown> = { type };
  for (const [field, kind] of Object.entries(shape)) {
    const v = c[field];
    const optional = kind.endsWith('?');
    if (v === undefined || v === null) {
      if (!optional && !kind.endsWith('esponse')) throw bad(`${type}.${field} is required`);
      if (kind === 'response' || kind === 'activationResponse') throw bad(`${type}.response must be "accept" or "decline"`);
      if (kind === 'standbyResponse') throw bad(`${type}.response must be "ready" or "not_tonight"`);
      continue;
    }
    const ok =
      kind.startsWith('string') && !kind.startsWith('strings')
        ? typeof v === 'string'
        : kind === 'strings?'
          ? Array.isArray(v) && v.every((x) => typeof x === 'string')
          : kind === 'number?'
            ? typeof v === 'number' && Number.isFinite(v)
            : kind === 'boolean?'
              ? typeof v === 'boolean'
              : kind === 'object'
                ? typeof v === 'object' && !Array.isArray(v)
                : kind === 'standbyResponse'
                  ? v === 'ready' || v === 'not_tonight'
                  : v === 'accept' || v === 'decline';
    if (!ok) throw bad(`${type}.${field} has the wrong type`);
    out[field] = v;
  }
  // The physician answers only for themselves (brief: "Accept or decline from a phone; nothing else").
  if ((type === 'respond' || type === 'respondStandby' || type === 'respondActivation') && out.physicianId === undefined) out.physicianId = actor.id;
  const commandId = typeof c.commandId === 'string' && c.commandId !== '' ? c.commandId : typeof body.commandId === 'string' && body.commandId !== '' ? body.commandId : randomUUID();
  const seq = c.expectedSeq ?? body.expectedSeq;
  if (seq !== undefined && (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0)) throw bad('expectedSeq must be a non-negative integer');
  return { ...out, commandId, actor, ...(seq === undefined ? {} : { expectedSeq: seq }) } as Command;
}

/** Messages returned to a physician's phone pass the PHI denylist too (brief "No patient information in any notification"). */
export function safeForPhysician(message: string): string {
  return findPhiViolations(message).length === 0 ? message : 'This offer can no longer be answered.';
}
