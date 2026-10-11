import { DATA_DIR } from './helpers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteItemCommand, DynamoDBClient, QueryCommand, TransactWriteItemsCommand, TransactionCanceledException, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planWithLog, type ActionEvent, type Command } from '@lookahead/engine';
import { dynamoRepos } from '@/server/repo/dynamo';
import { Store } from '@/server/store';

/**
 * Standby records persist through the same ActionRepo as offers (D-75/D-76,
 * D-90): the store appends whole action events, so standby_* events need no
 * storage code of their own. Two servers on one (mocked) DynamoDB table race
 * to record `respondActivation accept` for the same standby; the conditional
 * write on seq lets exactly one through, the loser re-applies against the
 * fresh log and the engine refuses the double accept (INVALID_STATE).
 * Mocked AWS only; no credentials are needed or read.
 */

type Item = Record<string, AttributeValue>;
const ddb = mockClient(DynamoDBClient);
let table: Map<string, Map<number, Item>>;

function fakeTable(): void {
  table = new Map();
  ddb.on(QueryCommand).callsFake((input: { ExpressionAttributeValues: Record<string, AttributeValue> }) => {
    const pk = input.ExpressionAttributeValues[':pk']?.S ?? '';
    return { Items: [...(table.get(pk)?.entries() ?? [])].sort(([a], [b]) => a - b).map(([, it]) => it) };
  });
  ddb.on(TransactWriteItemsCommand).callsFake((input: { TransactItems: { Put: { Item: Item; ConditionExpression?: string } }[] }) => {
    const puts = input.TransactItems.map((t) => t.Put);
    const reasons = puts.map((p) => (table.get(p.Item.pk?.S ?? '')?.has(Number(p.Item.sk?.N)) === true && p.ConditionExpression === 'attribute_not_exists(sk)' ? { Code: 'ConditionalCheckFailed' } : { Code: 'None' }));
    if (reasons.some((r) => r.Code !== 'None')) throw new TransactionCanceledException({ message: 'Transaction cancelled', $metadata: {}, CancellationReasons: reasons });
    for (const p of puts) {
      const pk = p.Item.pk?.S ?? '';
      if (!table.has(pk)) table.set(pk, new Map());
      table.get(pk)?.set(Number(p.Item.sk?.N), p.Item);
    }
    return {};
  });
  ddb.on(DeleteItemCommand).callsFake((input: { Key: Item }) => {
    table.get(input.Key.pk?.S ?? '')?.delete(Number(input.Key.sk?.N));
    return {};
  });
}

beforeEach(() => {
  ddb.reset();
  fakeTable();
});
afterEach(() => ddb.reset());

const coordinator = { role: 'coordinator', id: 'c' } as const;
const lead = { role: 'clinical_lead', id: 'l' } as const;

describe('two servers on one DynamoDB table: the standby double-activation race (D-90 "double-accept refusal")', () => {
  it('standby_* events persist through the ActionRepo; both servers accept the activation, exactly one standby_activated is stored, the loser gets INVALID_STATE "already activated"', async () => {
    const backend = { factory: dynamoRepos(new DynamoDBClient({ region: 'us-east-1' }), 'tbl'), describe: () => 'dynamo (mock)' };
    const serverA = new Store({ data: DATA_DIR, live: mkdtempSync(join(tmpdir(), 'lh-sa-')) }, { backend });
    await serverA.reset();
    const snap = serverA.snapshot();

    // The standby candidate comes from the engine's plan at this instant, never from a literal.
    const plan = planWithLog({ dataset: snap.dataset }, snap.log, snap.clock.nowMs).plan;
    const physicianId = plan.selected[0]?.physicianId;
    expect(physicianId).toBeDefined();
    if (physicianId === undefined) return;

    const run = async (server: Store, c: Record<string, unknown>) => server.command(c as unknown as Command);
    const proposed = await run(serverA, { type: 'proposeStandby', commandId: 'sb-propose', actor: coordinator, physicianId });
    expect(proposed.ok).toBe(true);
    const first = proposed.ok ? proposed.emitted[0] : undefined;
    expect(first?.type).toBe('standby_proposed');
    const standbyId = first !== undefined && 'standbyId' in first.payload ? first.payload.standbyId : '';
    expect(standbyId).not.toBe('');

    expect((await run(serverA, { type: 'approveStandby', commandId: 'sb-approve', actor: lead, standbyId })).ok).toBe(true);
    expect((await run(serverA, { type: 'respondStandby', commandId: 'sb-ready', actor: { role: 'physician', id: physicianId }, standbyId, physicianId, response: 'ready' })).ok).toBe(true);
    // The coordinator forces the activation (18:20 risk may not meet the trigger); the lead still approves (OQ-49).
    expect((await run(serverA, { type: 'proposeActivation', commandId: 'sb-act', actor: coordinator, standbyId, force: true, reason: 'race test' })).ok).toBe(true);
    expect((await run(serverA, { type: 'approveActivation', commandId: 'sb-act-ok', actor: lead, standbyId })).ok).toBe(true);

    // Every standby event so far went through the mocked table (persistence of the new record kinds).
    const key = `log#${snap.datasetMeta.key}`;
    const storedTypes = () => [...(table.get(key)?.values() ?? [])].map((it) => (JSON.parse(it.body?.S ?? '{}') as ActionEvent).type);
    expect(storedTypes()).toEqual(expect.arrayContaining(['standby_proposed', 'standby_approved', 'standby_prealert_sent', 'standby_prealert_delivered', 'standby_acknowledged', 'standby_activation_proposed', 'standby_activation_approved', 'standby_activation_sent', 'standby_activation_delivered']));

    // Server B boots from the same table and sees the delivered activation.
    const serverB = new Store({ data: DATA_DIR, live: mkdtempSync(join(tmpdir(), 'lh-sb-')) }, { backend });
    await serverB.ready;
    expect(serverB.snapshot().log.length).toBe(serverA.snapshot().log.length);

    const accept = (id: string) => ({ type: 'respondActivation', commandId: id, actor: { role: 'physician', id: physicianId }, standbyId, physicianId, response: 'accept' });
    const ra = await run(serverA, accept('act-on-A'));
    const rb = await run(serverB, accept('act-on-B'));
    expect(ra.ok).toBe(true);
    expect(rb).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(rb.ok ? '' : rb.message).toContain('already activated');
    expect(serverB.conflictsResolved).toBe(1);
    expect(storedTypes().filter((t) => t === 'standby_activated')).toHaveLength(1);

    // A restart replays the standby from the table: the fold on a third server reads one activated standby.
    const serverC = new Store({ data: DATA_DIR, live: mkdtempSync(join(tmpdir(), 'lh-sc-')) }, { backend });
    await serverC.ready;
    expect(serverC.snapshot().log.filter((e) => e.type === 'standby_activated')).toHaveLength(1);
    serverA.dispose();
    serverB.dispose();
    serverC.dispose();
  });
});
