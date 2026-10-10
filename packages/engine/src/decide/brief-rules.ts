/**
 * Numbers stated by the brief for the Decide layer (docs/brief_c2.md,
 * "Coverage and Split-Shift Eligibility", "Notification and Safety
 * Constraints", "Users and Decision Rights"). Interpretations live in policy.ts.
 */

/** "At least 10 hours have passed since their last shift ended, measured at the offered start time." */
export const MIN_REST_HOURS = 10;
/** "Hours worked in the trailing 7 days plus the offered hours do not exceed 60." */
export const MAX_HOURS_7D = 60;
/** "Offers are at least 2 hours long." */
export const MIN_OFFER_MINUTES = 120;
/** "No more than one open offer per physician, and no more than 3 offers per physician per week." */
export const MAX_OPEN_OFFERS_PER_PHYSICIAN = 1;
export const MAX_OFFERS_PER_WEEK = 3;
/** "Offers expire if not answered within 10 minutes." */
export const OFFER_EXPIRY_MINUTES = 10;

export type Actor = 'coordinator' | 'clinical_lead' | 'off_shift_physician' | 'system';

/**
 * "Users and Decision Rights": coordinator reassigns consults, contacts
 * physicians, proposes split-shift offers; the clinical lead approves offers
 * and authorizes escalations; the off-shift physician accepts or declines.
 * "Automated actions are permitted only for low-risk steps (for example, an
 * internal alert to the coordinator)."
 */
export const DECISION_RIGHTS = {
  REASSIGN_CONSULT: { proposer: 'coordinator', approver: null, acceptor: null, automationAllowed: false },
  ESCALATE_TO_CLINICAL_LEAD: { proposer: 'coordinator', approver: 'clinical_lead', acceptor: null, automationAllowed: false },
  SPLIT_SHIFT_OFFER: { proposer: 'coordinator', approver: 'clinical_lead', acceptor: 'off_shift_physician', automationAllowed: false },
  NOTE_HANDOFF_PLAN: { proposer: 'coordinator', approver: null, acceptor: null, automationAllowed: false },
  VERIFY_PRESENCE: { proposer: 'system', approver: null, acceptor: null, automationAllowed: true },
} as const satisfies Record<string, { proposer: Actor; approver: Actor | null; acceptor: Actor | null; automationAllowed: boolean }>;

export type InterventionKind = keyof typeof DECISION_RIGHTS;
