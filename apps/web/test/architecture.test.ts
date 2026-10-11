import { body, req } from './helpers';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import type { ActionEvent, ActionLog } from '@lookahead/engine';
import ArchitecturePage from '@/app/architecture/page';
import * as architectureRoute from '@/app/api/architecture/route';
import * as commandsRoute from '@/app/api/commands/route';
import * as resetRoute from '@/app/api/demo/reset/route';
import * as viewRoute from '@/app/api/view/route';
import type { CommandResponse, ViewDTO } from '@/lib/dto';
import { ARCHITECTURE_MERMAID, DECISION_TYPES, HUMAN_ROLES, PROPOSAL_TYPES, architectureCounters, scanHardcodedIds, type ArchitectureDTO, type CounterDTO } from '@/server/architecture';
import { LEAD_COOKIE, leadCookieValue, offerToken } from '@/server/auth';
import { disposeStore, getReadyStore } from '@/server/store';

/**
 * /architecture (sprint A4): the counters are recomputed here from the raw
 * action log with independent filters and must match the route exactly.
 * Brief "Users and Decision Rights": "Every offer is approved by the clinical
 * lead on duty before it is sent"; "Notification and Safety Constraints": "No
 * patient information in any notification".
 */

const leadCookie = () => `${LEAD_COOKIE}=${encodeURIComponent(leadCookieValue())}`;
const command = (role: string, cmd: Record<string, unknown>, actorId?: string) =>
  commandsRoute.POST(
    req('/api/commands', {
      method: 'POST',
      role,
      ...(actorId === undefined ? {} : { actorId }),
      ...(role === 'clinical_lead' ? { cookie: leadCookie() } : {}),
      body: JSON.stringify({ command: cmd, ...(role === 'physician' && typeof cmd.offerId === 'string' ? { token: offerToken(cmd.offerId) } : {}) }),
    }),
  );
const arch = async () => body<ArchitectureDTO>(await architectureRoute.GET());
const counter = (d: ArchitectureDTO, name: CounterDTO['name']) => d.counters.find((c) => c.name === name);

beforeEach(async () => {
  disposeStore();
  expect((await resetRoute.POST()).status).toBe(200);
});
afterAll(() => disposeStore());

/** Independent recount straight from the log (no shared helpers with server/architecture.ts beyond the type lists). */
function recount(log: ActionLog) {
  const human = (e: ActionEvent) => (HUMAN_ROLES as readonly string[]).includes(e.actor.role);
  const proposals = log.filter((e) => (PROPOSAL_TYPES as readonly string[]).includes(e.type) && human(e)).length;
  const ai = log.filter((e) => (DECISION_TYPES as readonly string[]).includes(e.type) && !human(e) && !(e.type === 'offer_cancelled' && e.payload.cause === 'gap_filled')).length;
  const delivered = log.filter((e) => e.type === 'offer_delivered');
  const approvedBefore = (d: ActionEvent) => log.some((a) => a.type === 'offer_approved' && a.seq < d.seq && a.actor.role === 'clinical_lead' && d.type === 'offer_delivered' && a.payload.offerId === d.payload.offerId);
  const unapprovedOffers = delivered.filter((d) => !approvedBefore(d)).length;
  const messages = log.filter((e) => ['offer_proposed', 'offer_sent', 'standby_proposed', 'standby_prealert_sent', 'standby_activation_proposed', 'standby_activation_sent', 'standby_released'].includes(e.type)).length;
  return { proposals, ai, delivered: delivered.length, unapprovedOffers, messages };
}

describe('GET /api/architecture counters match the action log exactly', () => {
  it('fresh reset: every counter is computed from an empty log', async () => {
    const d = await arch();
    expect(d.logLength).toBe((await getReadyStore()).snapshot().log.length);
    expect(counter(d, 'recommendations-acted-on')?.value).toBe(0);
    expect(counter(d, 'ai-decisions')?.value).toBe(0);
    expect(counter(d, 'unapproved-messages')?.value).toBe(0);
    // Blocked attempts are not in the append-only log: reported as not logged, never as 0.
    expect(counter(d, 'phi-blocked')?.value).toBeNull();
    expect(counter(d, 'phi-blocked')?.definition).toContain('Not logged');
  });

  it('propose (coordinator) -> approve (clinical lead) -> accept (physician): counters equal an independent recount', async () => {
    const v = await body<ViewDTO>(await viewRoute.GET(req('/api/view')));
    const physicianId = v.recommendedOffer?.physicianId;
    expect(physicianId).toBeDefined();
    const p = await command('coordinator', { type: 'proposeOffer', physicianId, commandId: 'arch-propose' });
    expect(p.status).toBe(200);
    const offerId = (await body<CommandResponse & { emitted: { offerId?: string }[] }>(p)).emitted[0]?.offerId ?? '';
    expect(offerId).not.toBe('');
    expect((await command('clinical_lead', { type: 'approveOffer', offerId, commandId: 'arch-approve' })).status).toBe(200);
    expect((await command('physician', { type: 'respond', offerId, response: 'accept', commandId: 'arch-accept' }, physicianId)).status).toBe(200);

    const log = (await getReadyStore()).snapshot().log;
    const d = await arch();
    const r = recount(log);
    expect(d.logLength).toBe(log.length);
    expect(log.length).toBeGreaterThan(3);
    expect(counter(d, 'recommendations-acted-on')?.value).toBe(r.proposals);
    expect(r.proposals).toBe(1);
    expect(counter(d, 'ai-decisions')?.value).toBe(r.ai);
    expect(r.ai).toBe(0);
    expect(counter(d, 'unapproved-messages')?.value).toBe(r.unapprovedOffers);
    expect(r.delivered).toBe(1);
    expect(r.unapprovedOffers).toBe(0);
    expect(counter(d, 'phi-checks-passed')?.value).toBe(r.messages);
    expect(r.messages).toBeGreaterThanOrEqual(2); // the proposal draft and the send-time text
    expect(counter(d, 'phi-recheck-violations')?.value).toBe(0);
    expect(counter(d, 'unapproved-messages')?.definition).toContain(`${r.delivered} deliveries`);
  });

  it('a refused command (coordinator approving) appends nothing and changes no counter', async () => {
    const v = await body<ViewDTO>(await viewRoute.GET(req('/api/view')));
    const p = await command('coordinator', { type: 'proposeOffer', physicianId: v.recommendedOffer?.physicianId, commandId: 'arch-p2' });
    const offerId = (await body<CommandResponse & { emitted: { offerId?: string }[] }>(p)).emitted[0]?.offerId ?? '';
    const before = await arch();
    expect((await command('coordinator', { type: 'approveOffer', offerId })).status).toBe(403);
    const after = await arch();
    expect(after.counters).toEqual(before.counters);
  });
});

describe('architectureCounters (pure) flags violations it is meant to catch', () => {
  const ev = (seq: number, type: string, role: string, payload: Record<string, unknown>): ActionEvent =>
    ({ actionId: `a${seq}`, seq, atMs: seq * 1000, actor: { role, id: `${role}-x` }, commandId: `c${seq}`, type, payload }) as unknown as ActionEvent;

  it('a delivery with no clinical-lead approval and a system approval are both counted', () => {
    const log: ActionLog = [
      ev(1, 'offer_proposed', 'coordinator', { offerId: 'o1', message: 'Shift offer for tonight' }),
      ev(2, 'offer_approved', 'system', { offerId: 'o1', note: null }),
      ev(3, 'offer_sent', 'system', { offerId: 'o1', channel: 'sms', message: 'Shift offer for tonight' }),
      ev(4, 'offer_delivered', 'system', { offerId: 'o1', channel: 'sms', simulated: true, expiresAtMs: 0 }),
      ev(5, 'offer_expired', 'system', { offerId: 'o1', expiredAtMs: 0 }),
      ev(6, 'offer_cancelled', 'system', { offerId: 'o1', reason: 'filled', cause: 'gap_filled', filledBy: null }),
    ];
    const c = architectureCounters(log);
    const get = (n: CounterDTO['name']) => c.counters.find((x) => x.name === n)?.value;
    expect(get('ai-decisions')).toBe(1); // the system approval; expiry and gap-filled cancel are materializations
    expect(get('unapproved-messages')).toBe(1);
    expect(get('phi-checks-passed')).toBe(2);
    expect(get('phi-recheck-violations')).toBe(0);
  });

  it('the request-time re-check catches a logged text that the denylist would refuse', () => {
    const log: ActionLog = [ev(1, 'offer_sent', 'system', { offerId: 'o1', channel: 'sms', message: 'patient waiting' })];
    expect(architectureCounters(log).counters.find((x) => x.name === 'phi-recheck-violations')?.value).toBe(1);
  });
});

describe('badges are computed at request time', () => {
  it('the engine source scan uses the no-hardcode regex and reports the files scanned', async () => {
    const d = await arch();
    expect(d.badges.hardcode.status).toBe('clean');
    expect(d.badges.hardcode.filesScanned).toBeGreaterThan(10);
    expect(d.badges.hardcode.hits).toEqual([]);
  });

  it('a planted literal is caught, and a missing directory is unavailable (never clean)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-scan-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.ts'), `export const x = '${'PHY'}-${'001'}';\n`);
    writeFileSync(join(dir, 'b.ts'), 'export const y = 1;\n');
    const s = scanHardcodedIds(dir);
    expect(s).toMatchObject({ status: 'hits', filesScanned: 2 });
    expect(s.hits).toEqual(['sub/a.ts:1']);
    expect(scanHardcodedIds(join(dir, 'missing')).status).toBe('unavailable');
  });

  it('the tests badge reflects docs/test-report.json or says there is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-tr-'));
    const file = join(dir, 'r.json');
    process.env.LOOKAHEAD_TEST_REPORT_FILE = file;
    try {
      expect((await arch()).badges.tests.status).toBe('none');
      const s = { files: 3, tests: 42, passed: 42, failed: 0, skipped: 0, durationMs: 10 };
      writeFileSync(file, JSON.stringify({ schemaVersion: '1.0', generatedAtMs: 1_700_000_000_000, command: 'pnpm test:report', suites: { engine: s, web: s }, total: s, ok: true }));
      expect((await arch()).badges.tests).toMatchObject({ status: 'pass', tests: 42, generatedAtMs: 1_700_000_000_000 });
    } finally {
      delete process.env.LOOKAHEAD_TEST_REPORT_FILE;
    }
  });
});

describe('docs/ARCHITECTURE.md', () => {
  it('carries the same Mermaid source the page shows', () => {
    const md = readFileSync(new URL('../../../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
    expect(md).toContain(`\`\`\`mermaid\n${ARCHITECTURE_MERMAID}\n\`\`\``);
    for (const node of ['EC2', 'DynamoDB', 'Bedrock', 'S3', '/api/v1/events', 'webhooks', 'fidelity guard']) expect(ARCHITECTURE_MERMAID).toContain(node);
  });
});

describe('/architecture page renders the computed data', () => {
  it('server render carries the hero, diagram, every counter value from the API and both badges', async () => {
    // The test transform compiles JSX to React.createElement (classic runtime).
    (globalThis as unknown as { React: typeof React }).React = React;
    const html = renderToString(await ArchitecturePage());
    const d = await arch();
    for (const id of ['architecture', 'ai-does', 'ai-never', 'arch-diagram', 'arch-counters', 'badge-hardcode', 'badge-tests']) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain('AI narrates. Humans decide.');
    for (const c of d.counters) expect(html).toContain(`data-testid="counter-${c.name}" data-value="${c.value === null ? 'null' : String(c.value)}"`);
    expect(html).toContain(`data-status="${d.badges.hardcode.status}"`);
  });
});
