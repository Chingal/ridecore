import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { reservationKey } from '../../src/infra/dynamo/keys.ts';
import { collect, evaluate } from '../../scripts/load/check.ts';
import { createTestTable, deleteTestTable, useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const client = createDynamoClient();
const doc = createDocumentClient(client);
let table: string;

beforeAll(async () => {
  table = await createTestTable(client, 'load-check');
});
afterAll(async () => {
  await deleteTestTable(client, table);
});

describe('load invariant checker against DynamoDB', () => {
  it('finds an orphan reservation (a passenger reserved for a trip that does not exist)', async () => {
    await doc.send(new PutCommand({ TableName: table, Item: { ...reservationKey('PASSENGER', 'load-passenger-9'), tripId: 'ghost-trip', entity: 'RESERVATION' } }));
    const { snapshot, read } = await collect({ table, env: {}, passengers: ['load-passenger-9'], drivers: [], waitMs: 0 });
    expect(evaluate(snapshot)).toEqual(['reservation PASSENGER#load-passenger-9 points to trip ghost-trip, which does not exist']);
    expect(read.trips).toBe(0);
  });
});
