import type { PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReconciler } from '../../src/events/reconciler.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { outboxKey, outboxPendingGsi2 } from '../../src/infra/dynamo/keys.ts';
import { createOutboxStore } from '../../src/infra/dynamo/outbox-store.ts';
import { createTestTable, deleteTestTable, useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const client = createDynamoClient();
const doc = createDocumentClient(client);
let table: string;

beforeAll(async () => {
  table = await createTestTable(client, 'reconciler');
});

afterAll(async () => {
  await deleteTestTable(client, table);
});

describe('reconciler (DynamoDB on Floci)', () => {
  it('publishes an event the stream never delivered', async () => {
    const tripId = randomUUID();
    const now = new Date();
    const occurredAt = new Date(now.getTime() - 5 * 60_000).toISOString();
    const event = {
      schemaVersion: 1,
      eventId: `${tripId}:1`,
      type: 'trip.requested',
      tripId,
      version: 1,
      occurredAt,
      payload: { fromState: null, toState: 'REQUESTED', passengerId: 'p-1', fareEstimate: 7000 },
      correlationId: 'reconciler-it',
    };
    // Written directly: no stream record reaches a publisher, as when the stream drops it.
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: { ...event, ...outboxKey(tripId, 1), ...outboxPendingGsi2(tripId, occurredAt, 1), entity: 'EVENT' },
      }),
    );

    const sent: PutEventsRequestEntry[] = [];
    const reconcile = createReconciler({
      store: createOutboxStore(doc, table),
      send: (entries) => {
        sent.push(...entries);
        return Promise.resolve(entries.map(() => ({ EventId: 'e' })));
      },
      busName: 'ridecore',
      log: () => undefined,
      now: () => now,
    });

    // GSI reads are eventually consistent on AWS: allow a few runs for the item to show up.
    let first = await reconcile();
    for (let i = 0; i < 25 && first.found === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      first = await reconcile();
    }
    expect(first).toMatchObject({ found: 1, published: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]?.Detail))).toEqual(event);

    const item = (await doc.send(new GetCommand({ TableName: table, Key: outboxKey(tripId, 1) }))).Item;
    expect(item).toMatchObject({ publishedAt: now.toISOString() });
    expect(item).not.toHaveProperty('GSI2PK');

    let second = await reconcile();
    for (let i = 0; i < 25 && second.found > 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      second = await reconcile();
    }
    expect(second.found).toBe(0);
  });
});
