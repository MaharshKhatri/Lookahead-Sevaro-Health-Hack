import 'server-only';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findPhiViolations, type ActionEvent, type ActionLog, type Role } from '@lookahead/engine';
import { repoRoot } from './paths';
import { readTestReport } from './testReport';

/**
 * /architecture (sprint A4): "AI narrates. Humans decide." Every number on
 * the page is computed here at request time from the store's action log and
 * from the repository itself; nothing is typed in. LOOKAHEAD-DEFINED counter
 * definitions, each grounded in brief "Users and Decision Rights" ("Every
 * offer is approved by the clinical lead on duty before it is sent"; "Any
 * message to a physician outside their shift requires a human approval") and
 * "Notification and Safety Constraints" ("No patient information in any
 * notification").
 */

/** Brief "Users and Decision Rights": the three people. `system` is the engine/delivery simulator, never a person. */
export const HUMAN_ROLES: readonly Role[] = ['coordinator', 'clinical_lead', 'physician'];
const isHuman = (r: Role) => HUMAN_ROLES.includes(r);

/** Proposal-type actions: a human acting on an engine recommendation (the engine ranks; a person proposes). */
export const PROPOSAL_TYPES = ['offer_proposed', 'standby_proposed', 'standby_activation_proposed', 'escalation_raised', 'reassignment_requested'] as const;

/**
 * Decision actions: choosing to propose, approve, reject, accept, decline,
 * authorize, release or manually cancel. Excluded as system materializations
 * (not decisions): offer_sent/delivered and the standby equivalents (the
 * delivery simulator executing an approval), offer_expired / standby_expired
 * (the 10-minute clock), offer_superseded (another physician accepted first),
 * offer_cancelled with cause gap_filled (the engine stopping offers once the
 * gap is filled, brief "stop sending offers once the gap is filled"), and
 * internal_alert_sent (brief: automated internal alerts are permitted).
 */
export const DECISION_TYPES = [
  ...PROPOSAL_TYPES,
  'offer_approved',
  'offer_rejected',
  'offer_accepted',
  'offer_declined',
  'offer_cancelled',
  'escalation_authorized',
  'standby_approved',
  'standby_rejected',
  'standby_acknowledged',
  'standby_declined',
  'standby_activation_approved',
  'standby_activation_rejected',
  'standby_activated',
  'standby_activation_declined',
  'standby_released',
  'standby_cancelled',
] as const;

/** Outbound physician messages: each delivery and the approval that must precede it (by subject id). */
const DELIVERY_APPROVAL: Readonly<Record<string, string>> = {
  offer_delivered: 'offer_approved',
  standby_prealert_delivered: 'standby_approved',
  standby_activation_delivered: 'standby_activation_approved',
};

/** Message texts in the log, each of which passed the engine PHI guard to be recorded (drafting check at proposal, re-check at send). */
const MESSAGE_TYPES = ['offer_proposed', 'offer_sent', 'standby_proposed', 'standby_prealert_sent', 'standby_activation_proposed', 'standby_activation_sent', 'standby_released'] as const;

export interface CounterDTO {
  readonly name: 'recommendations-acted-on' | 'ai-decisions' | 'unapproved-messages' | 'phi-checks-passed' | 'phi-recheck-violations' | 'phi-blocked';
  readonly label: string;
  /** null when the quantity is not recorded anywhere (shown as "not logged", never as 0). */
  readonly value: number | null;
  readonly expected: 'zero' | 'any';
  readonly definition: string;
  readonly breakdown: readonly { readonly key: string; readonly count: number }[];
}

export interface ArchitectureCounters {
  readonly logLength: number;
  readonly counters: readonly CounterDTO[];
}

const subjectId = (e: ActionEvent): string | null => {
  const p = e.payload as Record<string, unknown>;
  const id = p.offerId ?? p.standbyId ?? p.escalationId ?? p.consultId ?? null;
  return typeof id === 'string' ? id : null;
};

const tally = (events: readonly ActionEvent[]) => {
  const m = new Map<string, number>();
  for (const e of events) m.set(e.type, (m.get(e.type) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
};

const messageOf = (e: ActionEvent): string | null => {
  const p = e.payload as Record<string, unknown>;
  return typeof p.message === 'string' ? p.message : null;
};

/** Pure: every counter is a function of the action log alone. */
export function architectureCounters(log: ActionLog): ArchitectureCounters {
  const proposals = log.filter((e) => (PROPOSAL_TYPES as readonly string[]).includes(e.type) && isHuman(e.actor.role));

  const decisions = log.filter((e) => (DECISION_TYPES as readonly string[]).includes(e.type) && !(e.type === 'offer_cancelled' && e.payload.cause === 'gap_filled'));
  const aiDecisions = decisions.filter((e) => !isHuman(e.actor.role));

  const deliveries = log.filter((e) => e.type in DELIVERY_APPROVAL);
  const unapproved = deliveries.filter((d) => {
    const approvalType = DELIVERY_APPROVAL[d.type];
    const id = subjectId(d);
    return !log.some((a) => a.seq < d.seq && a.type === approvalType && a.actor.role === 'clinical_lead' && subjectId(a) === id);
  });
  // standby_released carries a message to the physician; it is issued by the clinical lead directly (COMMAND_ROLES.releaseStandby).
  const releases = log.filter((e) => e.type === 'standby_released');
  const unapprovedReleases = releases.filter((e) => e.actor.role !== 'clinical_lead');

  const messages = log.filter((e) => (MESSAGE_TYPES as readonly string[]).includes(e.type) && messageOf(e) !== null);
  const recheck = messages.filter((e) => findPhiViolations(messageOf(e) ?? '').length > 0);

  return {
    logLength: log.length,
    counters: [
      {
        name: 'recommendations-acted-on',
        label: 'Engine recommendations acted on',
        value: proposals.length,
        expected: 'any',
        definition: `Proposal-type actions recorded by a person (coordinator, clinical lead or physician): ${PROPOSAL_TYPES.join(', ')}. The engine ranks; a person chooses to propose.`,
        breakdown: tally(proposals),
      },
      {
        name: 'ai-decisions',
        label: 'Decisions made by AI',
        value: aiDecisions.length,
        expected: 'zero',
        definition:
          'Decision actions (propose, approve, reject, accept, decline, authorize, release, manual cancel) whose actor role is not coordinator, clinical lead or physician. Excluded as system materializations: deliveries, 10-minute expiries, superseded offers, gap-filled cancellations and automated internal alerts (brief: permitted low-risk automation).',
        breakdown: tally(aiDecisions),
      },
      {
        name: 'unapproved-messages',
        label: 'Messages sent without human approval',
        value: unapproved.length + unapprovedReleases.length,
        expected: 'zero',
        definition: `Physician deliveries (${Object.keys(DELIVERY_APPROVAL).join(', ')}) with no earlier approval of the same offer or standby by a clinical lead in the log, plus release messages not issued by a clinical lead. Checked against ${deliveries.length} deliveries and ${releases.length} releases.`,
        breakdown: tally([...unapproved, ...unapprovedReleases]),
      },
      {
        name: 'phi-checks-passed',
        label: 'PHI guard checks passed',
        value: messages.length,
        expected: 'any',
        definition: `Message texts recorded in the log (${MESSAGE_TYPES.join(', ')}). Each one passed the engine PHI guard to be recorded: the whitelist check when drafted at proposal and the re-check at send time; a text that fails either is refused and never enters the log.`,
        breakdown: tally(messages),
      },
      {
        name: 'phi-recheck-violations',
        label: 'PHI re-check violations now',
        value: recheck.length,
        expected: 'zero',
        definition: `Every logged message text re-run through the PHI denylist (findPhiViolations) at request time, as an independent check of the guard. ${messages.length} texts checked.`,
        breakdown: tally(recheck),
      },
      {
        name: 'phi-blocked',
        label: 'PHI guard blocks',
        value: null,
        expected: 'any',
        definition: 'Not logged. A blocked message is refused with PHI_BLOCKED and the command appends nothing to the append-only action log, so blocked attempts are not counted here; the refusal is returned to the caller only.',
        breakdown: [],
      },
    ],
  };
}

// ------------------------------------------------------------------ badges

/** The same pattern as packages/engine/test/no-hardcode.test.ts (CLAUDE.md rule 5). */
export const ID_LITERAL = /\b(PHY|CON|SYN|EVT)-\d+/;

export interface HardcodeBadge {
  readonly status: 'clean' | 'hits' | 'unavailable';
  readonly filesScanned: number;
  readonly hits: readonly string[];
  readonly dir: string;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

/** Scans *.ts under the engine source at request time; a missing directory (e.g. a trimmed deploy) is reported as unavailable, never as clean. */
export function scanHardcodedIds(dir = join(repoRoot(), 'packages', 'engine', 'src')): HardcodeBadge {
  if (!existsSync(dir)) return { status: 'unavailable', filesScanned: 0, hits: [], dir };
  try {
    const files = tsFiles(dir);
    if (files.length === 0) return { status: 'unavailable', filesScanned: 0, hits: [], dir };
    const hits = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (ID_LITERAL.test(line) ? [`${f.slice(dir.length + 1)}:${i + 1}`] : [])),
    );
    return { status: hits.length === 0 ? 'clean' : 'hits', filesScanned: files.length, hits, dir };
  } catch {
    return { status: 'unavailable', filesScanned: 0, hits: [], dir };
  }
}

export interface TestsBadge {
  readonly status: 'pass' | 'fail' | 'none';
  readonly tests: number | null;
  readonly passed: number | null;
  readonly failed: number | null;
  readonly files: number | null;
  readonly generatedAtMs: number | null;
  readonly command: string | null;
}

export function testsBadge(): TestsBadge {
  const r = readTestReport();
  if (r === null) return { status: 'none', tests: null, passed: null, failed: null, files: null, generatedAtMs: null, command: null };
  return { status: r.ok && r.total.failed === 0 ? 'pass' : 'fail', tests: r.total.tests, passed: r.total.passed, failed: r.total.failed, files: r.total.files, generatedAtMs: r.generatedAtMs, command: r.command };
}

export interface ArchitectureDTO extends ArchitectureCounters {
  readonly version: number;
  readonly nowMs: number;
  readonly badges: { readonly hardcode: HardcodeBadge; readonly tests: TestsBadge };
}

export function architectureReport(s: { readonly log: ActionLog; readonly version: number; readonly clock: { readonly nowMs: number } }): ArchitectureDTO {
  // The absolute path stays on the server; the DTO names the directory relative to the repo.
  const hardcode = { ...scanHardcodedIds(), dir: 'packages/engine/src' };
  return { version: s.version, nowMs: s.clock.nowMs, ...architectureCounters(s.log), badges: { hardcode, tests: testsBadge() } };
}

// ------------------------------------------------------------------ diagram source

/**
 * The deployed architecture as Mermaid source. The page draws the same
 * pipeline as hand-written SVG (no Mermaid runtime) and shows this text in a
 * <details>; docs/ARCHITECTURE.md carries the identical block (a test checks).
 */
export const ARCHITECTURE_MERMAID = `flowchart LR
  subgraph Sources
    CSV[Sevaro data package CSVs]
    V1[POST /api/v1/events ingest, HMAC signed]
    INJ[/inject demo rows/]
  end
  subgraph EC2["EC2: Next.js 15 server (Node)"]
    ING[ingest: schema-adaptive parse]
    REP[replay: event-time state]
    DET[detect: routing, standards, coverage, attention]
    FC[forecast: Hawkes surge model]
    DEC[decide / standby: needs, eligibility ledger, trap, what-if]
    APR{{approval: clinical lead PIN}}
    ACT[act: append-only action log, offer state machine]
    AUD[audit: per-offer trail, CSV]
    GUARD[[fidelity guard: numbers and names must match engine facts]]
  end
  subgraph People
    COORD([coordinator proposes])
    LEAD([clinical lead approves])
    PHYS([off-shift physician accepts on phone])
  end
  BR[(Amazon Bedrock narrator: sidecar, text only)]
  DDB[(DynamoDB: action log and injected rows)]
  S3[(S3: audit archive)]
  WH[outbound webhooks, signed]
  CSV --> ING
  V1 --> ING
  INJ --> ING
  ING --> REP --> DET --> FC --> DEC
  COORD --> DEC
  DEC -->|proposal| APR
  LEAD --> APR
  APR -->|approved, PHI re-checked| ACT
  PHYS --> ACT
  ACT --> AUD
  ACT --> DDB
  AUD --> S3
  ACT -->|store change, signed envelope| WH
  DEC -. engine facts .-> GUARD
  GUARD -. facts .-> BR
  BR -. draft sentences .-> GUARD
  GUARD -. narration text to UI only .-> COORD`;
