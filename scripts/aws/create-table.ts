/**
 * Creates the DynamoDB table that STORE=dynamo uses (apps/web/src/server/repo/dynamo.ts):
 *   pk (String, partition) = "log#<datasetKey>" | "events#<datasetKey>"
 *   sk (Number, sort)      = seq
 * On-demand billing, so there is nothing to size. Idempotent: an existing
 * table with the same key schema is reported and left alone.
 *
 *   pnpm aws:create-table [--table lookahead-log] [--region us-east-1]
 *
 * Credentials come from the default AWS chain (CloudShell, `aws configure`,
 * an instance profile); none are read from or written to this repository.
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  waitUntilTableExists,
  type TableDescription,
} from '@aws-sdk/client-dynamodb';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const table = arg('table') ?? process.env.TABLE_NAME ?? 'lookahead-log';
const region = arg('region') ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

function keysOk(t: TableDescription | undefined): boolean {
  const ks = t?.KeySchema ?? [];
  const attrs = new Map((t?.AttributeDefinitions ?? []).map((a) => [a.AttributeName, a.AttributeType]));
  return (
    ks.some((k) => k.AttributeName === 'pk' && k.KeyType === 'HASH') &&
    ks.some((k) => k.AttributeName === 'sk' && k.KeyType === 'RANGE') &&
    attrs.get('pk') === 'S' &&
    attrs.get('sk') === 'N'
  );
}

async function main(): Promise<void> {
  const client = new DynamoDBClient({ region });
  try {
    await client.send(
      new CreateTableCommand({
        TableName: table,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'N' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        Tags: [{ Key: 'app', Value: 'lookahead' }],
      }),
    );
    console.log(`creating ${table} in ${region} (on-demand)...`);
  } catch (e) {
    if (!(e instanceof ResourceInUseException)) throw e;
    console.log(`${table} already exists in ${region}`);
  }
  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: table });
  const d = await client.send(new DescribeTableCommand({ TableName: table }));
  const t = d.Table;
  if (!keysOk(t)) {
    console.error(`${table} exists but its key schema is not pk (S, HASH) + sk (N, RANGE); pick another --table name.`);
    process.exit(1);
  }
  console.log(`${t?.TableName} ${t?.TableStatus} ${t?.BillingModeSummary?.BillingMode ?? 'PAY_PER_REQUEST'} ${t?.TableArn}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
