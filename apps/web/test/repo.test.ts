import { DATA_DIR } from './helpers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteItemCommand, DynamoDBClient, QueryCommand, TransactWriteItemsCommand, TransactionCanceledException, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionEvent, Command } from '@lookahead/engine';
import { DynamoActionRepo, dynamoRepos, isConditionalCancel } from '@/server/repo/dynamo';
import { fileRepos } from '@/server/repo/file';
import { withFallback } from '@/server/repo';
import { Store } from '@/server/store';

/**
 * Storage contract (D-75/D-76): append is atomic per seq; two writers racing
 * for the same seq get exactly one success. DynamoDB is exercised through a
 * mocked client that implements the conditional semantics of the real table.
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

const ev = (seq: number): ActionEvent =>
  ({ actionId: `a${seq}`, seq, atMs: 1, actor: { role: 'system', id: 't' }, commandId: `c${seq}`, type: 'internal_alert_sent', payload: { alertId: `x${seq}`, message: 'm', physicianIds: [], automated: true } }) as ActionEvent;

beforeEach(() => {
  ddb.reset();
  fakeTable();
});
afterEach(() => ddb.reset());

describe('DynamoActionRepo (mocked client)', () => {
  const repo = () => new DynamoActionRepo(new DynamoDBClient({ region: 'us-east-1' }), 'lookahead-test', 'ds-test');

  it('appends with a per-item attribute_not_exists(sk) condition in one TransactWriteItems, and loads in seq order', async () => {
    const r = repo();
    expect(await r.append(0, [ev(1), ev(2)])).toEqual({ ok: true });
    const call = ddb.commandCalls(TransactWriteItemsCommand)[0]?.args[0].input;
    expect(call?.TransactItems?.map((t) => [t.Put?.Item?.pk?.S, t.Put?.Item?.sk?.N, t.Put?.ConditionExpression])).toEqual([
      ['log#ds-test', '1', 'attribute_not_exists(sk)'],
      ['log#ds-test', '2', 'attribute_not_exists(sk)'],
    ]);
    expect((await r.load()).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('a second writer for the same seq gets a conflict, not an overwrite (ConditionalCheckFailed)', async () => {
    const a = repo();
    const b = repo();
    expect(await a.append(0, [ev(1)])).toEqual({ ok: true });
    const lost = await b.append(0, [{ ...ev(1), commandId: 'other' } as ActionEvent]);
    expect(lost).toMatchObject({ ok: false, conflict: true });
    expect((await a.load())[0]?.commandId).toBe('c1');
  });

  it('infrastructure errors are not conflicts (they propagate to the fallback wrapper)', async () => {
    ddb.on(TransactWriteItemsCommand).rejects(Object.assign(new Error('no credentials'), { name: 'CredentialsProviderError' }));
    await expect(repo().append(0, [ev(1)])).rejects.toThrow('no credentials');
    expect(isConditionalCancel(Object.assign(new Error('x'), { name: 'CredentialsProviderError' }))).toBe(false);
  });

  it('clear deletes every item of the partition', async () => {
    const r = repo();
    await r.append(0, [ev(1), ev(2), ev(3)]);
    await r.clear();
    expect(ddb.commandCalls(DeleteItemCommand)).toHaveLength(3);
    expect(await r.load()).toEqual([]);
  });
});

describe('fallback: AWS unavailable -> file store, demo unchanged', () => {
  it('a failing primary degrades to the file repo, seeded with what was already written', async () => {
    const live = mkdtempSync(join(tmpdir(), 'lh-fb-'));
    const backend = withFallback(dynamoRepos(new DynamoDBClient({ region: 'us-east-1' }), 'tbl'), fileRepos(live), 'dynamo (tbl)');
    const repos = backend.factory('ds-x');
    expect(await repos.actions.append(0, [ev(1)])).toEqual({ ok: true });
    expect(backend.describe()).toBe('dynamo (tbl)');
    ddb.on(TransactWriteItemsCommand).rejects(Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' }));
    expect(await repos.actions.append(1, [ev(2)])).toEqual({ ok: true });
    expect(backend.describe()).toMatch(/^file \(dynamo unavailable: AccessDeniedException/);
    expect((await fileRepos(live)('ds-x').actions.load()).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('two servers on one DynamoDB table: the double-accept race (brief "Handle the case where two physicians accept the same offer")', () => {
  it('both servers try to accept the same offer; exactly one acceptance is stored, the loser re-applies and is refused', async () => {
    const backend = { factory: dynamoRepos(new DynamoDBClient({ region: 'us-east-1' }), 'tbl'), describe: () => 'dynamo (mock)' };
    const serverA = new Store({ data: DATA_DIR, live: mkdtempSync(join(tmpdir(), 'lh-a-')) }, { backend });
    await serverA.reset();
    const now = serverA.snapshot();
    const physicianId = 'PHY-009';
    const p = await serverA.command({ type: 'proposeOffer', commandId: 'p', actor: { role: 'coordinator', id: 'c' }, physicianId } as Command);
    const offerId = p.ok && p.emitted[0]?.type === 'offer_proposed' ? p.emitted[0].payload.offerId : '';
    expect((await serverA.command({ type: 'approveOffer', commandId: 'a', actor: { role: 'clinical_lead', id: 'l' }, offerId } as Command)).ok).toBe(true);

    // Server B boots from the same table (sees the delivered offer), then both accept.
    const serverB = new Store({ data: DATA_DIR, live: mkdtempSync(join(tmpdir(), 'lh-b-')) }, { backend });
    await serverB.ready;
    expect(serverB.snapshot().log.length).toBe(serverA.snapshot().log.length);
    const accept = (id: string): Command => ({ type: 'respond', commandId: id, actor: { role: 'physician', id: physicianId }, offerId, physicianId, response: 'accept' }) as Command;
    const ra = await serverA.command(accept('accept-on-A'));
    const rb = await serverB.command(accept('accept-on-B'));
    expect(ra.ok).toBe(true);
    expect(rb).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(serverB.conflictsResolved).toBe(1);
    const stored = [...(table.get(`log#${now.datasetMeta.key}`)?.values() ?? [])].map((it) => JSON.parse(it.body?.S ?? '{}') as ActionEvent);
    expect(stored.filter((e) => e.type === 'offer_accepted')).toHaveLength(1);
    serverA.dispose();
    serverB.dispose();
  });
});
