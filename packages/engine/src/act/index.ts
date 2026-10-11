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
export { applyCommand, COMMAND_ROLES, decideWithLog, recommendNext, planWithLog, standDownRecommended, activationRecommended, type ActContext } from './commands';
export {
  foldStandbys,
  standbyStatus,
  standbyInFlight,
  activationLapsed,
  activatedStandbysOf,
  standbyOfferLogEntries,
  standbyHistoryOf,
  activationTrigger,
  quietAt,
  standbyAllowedActions,
  planFromDecision,
  STANDBY_IN_FLIGHT,
  type StandbyRecord,
  type StandbyStatus,
  type PlanContext,
} from './standby';
export { auditTrail, auditCsv, AUDIT_CSV_COLUMNS, actionAuditRows, actionsCsv, ACTION_CSV_COLUMNS, REASSIGNMENT_NO_APPROVAL_NOTE, type AuditTrail, type ActionAuditRow, type ApprovalState } from './audit';
