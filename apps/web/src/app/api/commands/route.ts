import { requireLead, verifyOfferToken } from '@/server/auth';
import { actorFrom, parseCommand, safeForPhysician } from '@/server/commands';
import { errorJson, guard, json, readJson } from '@/server/http';
import { StoreError, getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/commands {command} with x-lookahead-role and x-lookahead-actor-id.
 * The engine's applyCommand decides (roles, eligibility, caps, PHI guard,
 * idempotency by commandId, optimistic expectedSeq -> 409 CONFLICT).
 * OQ-44: clinical-lead commands need the lead PIN cookie; a physician's
 * answer needs the offer link token (x-lookahead-offer-token or body.token).
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    const actor = actorFrom(req.headers);
    const body = await readJson(req);
    const command = parseCommand(body, actor);
    if (actor.role === 'clinical_lead') requireLead(req);
    if (command.type === 'respond') {
      const token = req.headers.get('x-lookahead-offer-token') ?? (typeof body.token === 'string' ? body.token : null);
      if (!verifyOfferToken(command.offerId, token)) throw new StoreError('BAD_TOKEN', 'answer from the offer link you received (its token is missing or wrong)');
    }
    const r = await (await getReadyStore()).command(command);
    if (!r.ok) return errorJson(r.code, actor.role === 'physician' ? safeForPhysician(r.message) : r.message);
    return json({
      ok: true,
      replayed: r.replayed,
      seq: r.seq,
      commandId: command.commandId,
      emitted: r.emitted.map((e) => ({ type: e.type, seq: e.seq, actionId: e.actionId, ...('offerId' in e.payload ? { offerId: e.payload.offerId } : {}) })),
      coverage: r.coverage,
    });
  });
}
