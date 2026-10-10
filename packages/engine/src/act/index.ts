// Act layer (brief "Problem to Solve" layer 3): append-only action log, pure
// command processor, offer state machine, audit trail.
export * from './types';
export { actionIdOf, actionsKnownAt, appendActions, eventsOfCommand, headSeq, type PendingAction } from './log';
export {
  acceptedOffersOf,
  allowedActions,
  effectiveStartMs,
  expiresAt,
  foldOffers,
  IN_FLIGHT,
  isExpired,
  listOffers,
  offerLogEntries,
  offerState,
  statusOf,
  TERMINAL,
  type OfferRecord,
  type OfferState,
  type OfferStatus,
  type OfferView,
} from './offers';
export { coverageEffectOf, fillStatus, frozenNeed, type FillStatus } from './fill';
export { applyCommand, COMMAND_ROLES, decideWithLog, recommendNext, type ActContext } from './commands';
export { auditTrail, auditCsv, AUDIT_CSV_COLUMNS, type AuditTrail } from './audit';
