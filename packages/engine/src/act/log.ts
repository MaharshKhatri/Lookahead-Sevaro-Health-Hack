import type { EpochMs } from '../types';
import { fnv1a } from '../util/hash';
import type { ActionEvent, ActionLog, ActionPayload, ActorRef } from './types';

/**
 * Append-only action log (brief "Log every offer: who was considered, who was
 * excluded and why, who approved, and the outcome"). It is ours and separate
 * from Sevaro's event stream: nothing here touches dataset.events, so the
 * replayed Sevaro state is unaffected by any action log.
 */

/** Deterministic id: hash of the command's idempotency key and the event's index within the command. */
export function actionIdOf(commandId: string, index: number): string {
  return `act-${fnv1a(`${commandId}#${index}`)}`;
}

/** Seq of the last event (0 for an empty log): the version a caller passes as expectedSeq. */
export function headSeq(log: ActionLog): number {
  return log.at(-1)?.seq ?? 0;
}

/** Knowledge time: the actions applied at or before nowMs. */
export function actionsKnownAt(log: ActionLog, nowMs: EpochMs): ActionLog {
  return log.filter((e) => e.atMs <= nowMs);
}

export function eventsOfCommand(log: ActionLog, commandId: string): ActionLog {
  return log.filter((e) => e.commandId === commandId);
}

export type PendingAction = ActionPayload & { readonly actor?: ActorRef };

/** Returns a new log with the payloads appended (the input log is never mutated). A payload may name its own actor (e.g. the system). */
export function appendActions(log: ActionLog, atMs: EpochMs, actor: ActorRef, commandId: string, payloads: readonly PendingAction[]): { log: ActionLog; emitted: ActionEvent[] } {
  const base = headSeq(log);
  const emitted = payloads.map((p, i) => Object.freeze({ ...p, actionId: actionIdOf(commandId, i), seq: base + i + 1, atMs, actor: p.actor ?? actor, commandId }) as ActionEvent);
  return { log: Object.freeze([...log, ...emitted]), emitted };
}
