import {
  CreateTableCommand,
  DeleteTableCommand,
  type DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { TABLE_DEFINITION } from '../../../src/infra/dynamo/keys.ts';

/** Local Floci defaults so integration tests do not depend on a sourced `.env`. */
export function useFlociEnv(): void {
  process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4567';
  process.env.AWS_REGION ??= 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
}

/** Creates a uniquely named table with the same definition the CDK stack deploys. */
export async function createTestTable(client: DynamoDBClient, prefix: string): Promise<string> {
  const def = TABLE_DEFINITION;
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  const keyAttributes = [
    def.partitionKey,
    def.sortKey,
    ...def.globalSecondaryIndexes.flatMap((g) => [g.partitionKey, g.sortKey]),
  ];
  await client.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: keyAttributes.map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
      KeySchema: [
        { AttributeName: def.partitionKey, KeyType: 'HASH' },
        { AttributeName: def.sortKey, KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: def.globalSecondaryIndexes.map((g) => ({
        IndexName: g.indexName,
        KeySchema: [
          { AttributeName: g.partitionKey, KeyType: 'HASH' },
          { AttributeName: g.sortKey, KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      })),
      StreamSpecification: { StreamEnabled: true, StreamViewType: def.streamViewType },
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: name });
  return name;
}

export async function deleteTestTable(client: DynamoDBClient, name: string): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: name }));
}
