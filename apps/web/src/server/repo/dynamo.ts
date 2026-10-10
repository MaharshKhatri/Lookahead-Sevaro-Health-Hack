import 'server-only';
import { DeleteItemCommand, DynamoDBClient, QueryCommand, TransactWriteItemsCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import type { ActionEvent } from '@lookahead/engine';
import type { ActionRepo, AppendResult, EventRepo, InjectedRow, RepoFactory } from './types';

/**
 * DynamoDB storage (STORE=dynamo). One table, two item families:
 *   pk = "log#<datasetKey>",    sk = seq (Number), body = ActionEvent JSON
 *   pk = "events#<datasetKey>", sk = seq (Number), body = InjectedRow JSON
 * `append` writes all new items in one TransactWriteItems, each with
 * ConditionExpression attribute_not_exists(sk). Two servers (or two requests)
 * racing for the same seq: exactly one transaction commits, the other is
 * cancelled with ConditionalCheckFailed and reported as a conflict; the store
 * then reloads the log and re-applies the command through the engine
 * (expectedSeq / state checks). This is the storage-level guarantee that two
 * physicians can never both accept the same offer (DECISIONS D-76).
 */

/** DynamoDB TransactWriteItems limit. */
const MAX_TRANSACT_ITEMS = 100;

type Item = Record<string, AttributeValue>;

class Partition {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
    readonly pk: string,
  ) {}

  async items(): Promise<Item[]> {
    const out: Item[] = [];
    let start: Item | undefined;
    do {
      const r = await this.client.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: this.pk } }, ScanIndexForward: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }),
      );
      out.push(...(r.Items ?? []));
      start = r.LastEvaluatedKey;
    } while (start !== undefined);
    return out;
  }

  async putAll(entries: readonly { seq: number; body: unknown }[]): Promise<AppendResult> {
    for (let i = 0; i < entries.length; i += MAX_TRANSACT_ITEMS) {
      const chunk = entries.slice(i, i + MAX_TRANSACT_ITEMS);
      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: chunk.map((e) => ({
              Put: {
                TableName: this.table,
                Item: { pk: { S: this.pk }, sk: { N: String(e.seq) }, body: { S: JSON.stringify(e.body) } },
                ConditionExpression: 'attribute_not_exists(sk)',
              },
            })),
          }),
        );
      } catch (err) {
        if (isConditionalCancel(err)) return { ok: false, conflict: true, detail: `seq ${chunk[0]?.seq}..${chunk.at(-1)?.seq} already written in ${this.pk}` };
        throw err;
      }
    }
    return { ok: true };
  }

  async clear(): Promise<void> {
    for (const it of await this.items()) {
      await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: { pk: { S: this.pk }, sk: it.sk ?? { N: '0' } } }));
    }
  }
}

export function isConditionalCancel(err: unknown): boolean {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
  if (e === null || typeof e !== 'object') return false;
  if (e.name === 'ConditionalCheckFailedException') return true;
  return e.name === 'TransactionCanceledException' && (e.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');
}

const bodyOf = <T>(it: Item): T => JSON.parse(it.body?.S ?? 'null') as T;

export class DynamoActionRepo implements ActionRepo {
  readonly kind = 'dynamo';
  private readonly p: Partition;
  constructor(client: DynamoDBClient, table: string, datasetKey: string) {
    this.p = new Partition(client, table, `log#${datasetKey}`);
  }
  async load(): Promise<ActionEvent[]> {
    return (await this.p.items()).map((it) => bodyOf<ActionEvent>(it)).sort((a, b) => a.seq - b.seq);
  }
  async append(expectedSeq: number, events: readonly ActionEvent[]): Promise<AppendResult> {
    if (events.some((e, i) => e.seq !== expectedSeq + i + 1)) return { ok: false, conflict: true, detail: `events are not numbered from seq ${expectedSeq + 1}` };
    return this.p.putAll(events.map((e) => ({ seq: e.seq, body: e })));
  }
  clear(): Promise<void> {
    return this.p.clear();
  }
}

export class DynamoEventRepo implements EventRepo {
  readonly kind = 'dynamo';
  private readonly p: Partition;
  constructor(client: DynamoDBClient, table: string, datasetKey: string) {
    this.p = new Partition(client, table, `events#${datasetKey}`);
  }
  async load(): Promise<InjectedRow[]> {
    return (await this.p.items()).map((it) => bodyOf<InjectedRow>(it)).sort((a, b) => a.seq - b.seq);
  }
  append(rows: readonly InjectedRow[]): Promise<AppendResult> {
    return this.p.putAll(rows.map((r) => ({ seq: r.seq, body: r })));
  }
  clear(): Promise<void> {
    return this.p.clear();
  }
}

export const dynamoRepos =
  (client: DynamoDBClient, table: string): RepoFactory =>
  (datasetKey) => ({ actions: new DynamoActionRepo(client, table, datasetKey), events: new DynamoEventRepo(client, table, datasetKey) });
