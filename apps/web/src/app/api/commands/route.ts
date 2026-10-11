import { COMMAND_ROLES } from '@lookahead/engine';
import { clientKey, requireRoleSession, verifyOfferToken, verifyStandbyToken } from '@/server/auth';
import { actorFrom, parseCommand, safeForPhysician } from '@/server/commands';
import { errorJson, guard, json, readJson } from '@/server/http';
import { enforceRateLimit } from '@/server/ratelimit';
import { StoreError, getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/commands {command} with x-lookahead-role and x-lookahead-actor-id.
 * The engine's applyCommand decides (roles, eligibility, caps, PHI guard,
 * idempotency by commandId, optimistic expectedSeq -> 409 CONFLICT).
 * D-91 (server-side, before the store):
 *  1. the role must be granted by this browser's session (coordinator is free
 *     in DEMO_MODE; the lead needs the PIN; DEMO_MODE=false needs a cookie for
 *     every role) -> 401;
 *  2. the actor role must be allowed for the command type by the engine's
 *     COMMAND_ROLES (brief "Users and Decision Rights") -> 403 FORBIDDEN_ROLE;
 *  3. a physician's answer needs the offer link token (x-lookahead-offer-token
 *     or body.token) -> 403 BAD_TOKEN, and physician calls are rate limited.
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    const actor = actorFrom(req.headers);
    const body = await readJson(req);
    const command = parseCommand(body, actor);
    // Authenticate the role first (401), then authorize the command for it (403).
    requireRoleSession(req, actor.role);
    const allowed = COMMAND_ROLES[command.type];
    if (!allowed.includes(actor.role)) throw new StoreError('FORBIDDEN_ROLE', `${actor.role} may not ${command.type} (allowed: ${allowed.join(', ')}; brief "Users and Decision Rights")`);
    if (actor.role === 'physician') enforceRateLimit('physician', clientKey(req));
    const token = req.headers.get('x-lookahead-offer-token') ?? (typeof body.token === 'string' ? body.token : null);
    if (command.type === 'respond') {
      if (!verifyOfferToken(command.offerId, token)) throw new StoreError('BAD_TOKEN', 'answer from the offer link you received (its token is missing or wrong)');
    }
    // Standby answers (pre-alert and activation) need the standby link token, exactly like an offer (Phase 7).
    if (command.type === 'respondStandby' || command.type === 'respondActivation') {
      if (!verifyStandbyToken(command.standbyId, token)) throw new StoreError('BAD_TOKEN', 'answer from the standby link you received (its token is missing or wrong)');
    }
    const r = await (await getReadyStore()).command(command);
    if (!r.ok) return errorJson(r.code, actor.role === 'physician' ? safeForPhysician(r.message) : r.message);
    return json({
      ok: true,
      replayed: r.replayed,
      seq: r.seq,
      commandId: command.commandId,
      emitted: r.emitted.map((e) => ({ type: e.type, seq: e.seq, actionId: e.actionId, ...('offerId' in e.payload ? { offerId: e.payload.offerId } : {}), ...('standbyId' in e.payload ? { standbyId: e.payload.standbyId } : {}) })),
      coverage: r.coverage,
    });
  });
}
