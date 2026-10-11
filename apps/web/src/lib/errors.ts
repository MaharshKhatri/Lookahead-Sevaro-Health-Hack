/**
 * Engine error codes (packages/engine/src/act/types.ts ErrorCode) in plain
 * English for toasts, and their HTTP status for the API. The engine message
 * is always shown alongside; this only adds a readable lead.
 */
export const ERROR_TEXT: Readonly<Record<string, string>> = {
  FORBIDDEN_ROLE: 'Your role is not allowed to do that.',
  NOT_OWN_OFFER: 'This offer was made to a different physician.',
  NOT_ELIGIBLE: 'That physician is not eligible right now.',
  OPEN_OFFER_EXISTS: 'That physician already has an open offer.',
  WEEKLY_CAP: 'That physician has reached 3 offers this week.',
  EXPIRED: 'The offer expired before it was answered.',
  NO_LONGER_AVAILABLE: 'The offer is no longer available.',
  INVALID_STATE: 'Not possible in the current state.',
  PHI_BLOCKED: 'Blocked: the message failed the patient-information check.',
  CONFLICT: 'Someone else acted first. The view has been refreshed.',
  UNKNOWN_OFFER: 'Unknown offer.',
  NEED_ALREADY_FILLED: 'That gap is already filled by an accepted offer.',
  BAD_REQUEST: 'The request was malformed.',
  PIN_REQUIRED: 'Enter the clinical lead PIN first.',
  ROLE_SESSION_REQUIRED: 'Sign in with the PIN for this role first.',
  RATE_LIMITED: 'Too many requests; wait a minute and retry.',
  BAD_TOKEN: 'This offer link is not valid.',
  BAD_DATASET: 'That dataset does not ingest.',
  UNKNOWN_STAGE: 'That upload is no longer available; upload again.',
  NOT_FOUND: 'Not found.',
  INTERNAL: 'Server error.',
};

export const ERROR_STATUS: Readonly<Record<string, number>> = {
  FORBIDDEN_ROLE: 403,
  NOT_OWN_OFFER: 403,
  NOT_ELIGIBLE: 422,
  OPEN_OFFER_EXISTS: 409,
  WEEKLY_CAP: 409,
  EXPIRED: 410,
  NO_LONGER_AVAILABLE: 410,
  INVALID_STATE: 409,
  PHI_BLOCKED: 422,
  CONFLICT: 409,
  UNKNOWN_OFFER: 404,
  NEED_ALREADY_FILLED: 409,
  BAD_REQUEST: 400,
  PIN_REQUIRED: 401,
  ROLE_SESSION_REQUIRED: 401,
  RATE_LIMITED: 429,
  BAD_TOKEN: 403,
  BAD_DATASET: 422,
  UNKNOWN_STAGE: 404,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

export function plainError(code: string | undefined, message: string | undefined): string {
  const lead = code === undefined ? 'Request failed.' : (ERROR_TEXT[code] ?? code);
  return message === undefined || message === '' ? lead : `${lead} ${message}`;
}
