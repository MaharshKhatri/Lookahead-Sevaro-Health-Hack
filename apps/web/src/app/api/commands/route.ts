import { actorFrom, parseCommand, safeForPhysician } from '@/server/commands';
import { errorJson, guard, json, readJson } from '@/server/http';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/commands {command} with x-lookahead-role and x-lookahead-actor-id.
 * The engine's applyCommand decides (roles, eligibility, caps, PHI guard,
 * idempotency by commandId, optimistic expectedSeq -> 409 CONFLICT).
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    const actor = actorFrom(req.headers);
    const command = parseCommand(await readJson(req), actor);
    const r = await getStore().command(command);
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
