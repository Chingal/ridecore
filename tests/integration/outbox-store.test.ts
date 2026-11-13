import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { outboxKey, outboxPendingGsi2, outboxShard } from '../../src/infra/dynamo/keys.ts';
import { createOutboxStore, type OutboxStore } from '../../src/infra/dynamo/outbox-store.ts';
import { createTestTable, deleteTestTable, useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const client = createDynamoClient();
const doc = createDocumentClient(client);
let table: string;
let store: OutboxStore;

beforeAll(async () => {
  table = await createTestTable(client, 'outbox-store');
  store = createOutboxStore(doc, table);
});

afterAll(async () => {
  await deleteTestTable(client, table);
});

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

/** A trip id that lands in `shard`, so tests can fill one shard on purpose. */
function tripInShard(shard: number): string {
  for (;;) {
    const id = randomUUID();
    if (outboxShard(id) === shard) return id;
  }
}

async function putPending(tripId: string, occurredAt: string, version = 1): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: table,
      Item: {
        schemaVersion: 1,
        eventId: `${tripId}:${version}`,
        type: 'trip.requested',
        tripId,
        version,
        occurredAt,
        payload: {},
        ...outboxKey(tripId, version),
        ...outboxPendingGsi2(tripId, occurredAt, version),
        entity: 'EVENT',
      },
    }),
  );
}

async function raw(tripId: string, version = 1) {
  return (await doc.send(new GetCommand({ TableName: table, Key: outboxKey(tripId, version) }))).Item;
}

/** GSI reads are eventually consistent on AWS: retry until `check` holds or 5 s pass. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 25 && !check(value); i++) {
    await new Promise((r) => setTimeout(r, 200));
    value = await read();
  }
  return value;
}

const ids = (items: Record<string, unknown>[]) => items.map((i) => i.tripId);

describe('OutboxStore (DynamoDB on Floci)', () => {
  it('pending returns only markers older than the cut, oldest first', async () => {
    const shard = 1;
    const [a, b, c] = [tripInShard(shard), tripInShard(shard), tripInShard(shard)];
    await putPending(c, ago(10));
    await putPending(a, ago(120));
    await putPending(b, ago(90));
    const mine = (items: Record<string, unknown>[]) => ids(items).filter((id) => [a, b, c].includes(String(id)));
    const items = await eventually(() => store.pending(shard, ago(60), 100), (v) => mine(v).length >= 2);
    expect(mine(items)).toEqual([a, b]);
  });

  it('pending respects the limit', async () => {
    const shard = 2;
    for (let i = 0; i < 25; i++) await putPending(tripInShard(shard), ago(300 + i));
    const all = await eventually(() => store.pending(shard, ago(60), 100), (v) => v.length >= 25);
    expect(all.length).toBeGreaterThanOrEqual(25);
    expect(await store.pending(shard, ago(60), 7)).toHaveLength(7);
  });

  it('clear removes the marker and stamps publishedAt', async () => {
    const shard = 3;
    const id = tripInShard(shard);
    await putPending(id, ago(200));
    await store.clear(outboxKey(id, 1), '2026-11-13T12:00:05.000Z');
    const item = await raw(id);
    expect(item).toMatchObject({ ...outboxKey(id, 1), publishedAt: '2026-11-13T12:00:05.000Z' });
    expect(item).not.toHaveProperty('GSI2PK');
    expect(item).not.toHaveProperty('GSI2SK');
    const left = await eventually(() => store.pending(shard, ago(0), 1000), (v) => !ids(v).includes(id));
    expect(ids(left)).not.toContain(id);
  });

  it('clear ignores a missing item', async () => {
    const id = randomUUID();
    await expect(store.clear(outboxKey(id, 1), '2026-11-13T12:00:05.000Z')).resolves.toBeUndefined();
    expect(await raw(id)).toBeUndefined();
  });

  it('defer moves the marker to the back of its shard', async () => {
    const shard = 4;
    const id = tripInShard(shard);
    await putPending(id, ago(200));
    const later = outboxPendingGsi2(id, ago(-30), 1).GSI2SK; // 30 s after NOW
    await store.defer(outboxKey(id, 1), later);
    expect(await raw(id)).toMatchObject({ GSI2SK: later, outboxAttempts: 1 });
    const old = await eventually(() => store.pending(shard, ago(60), 1000), (v) => !ids(v).includes(id));
    expect(ids(old)).not.toContain(id);
    expect(ids(await store.pending(shard, ago(-60), 1000))).toContain(id);
  });

  it('defer ignores an item whose marker is already gone', async () => {
    const id = tripInShard(5);
    await putPending(id, ago(200));
    await store.clear(outboxKey(id, 1), '2026-11-13T12:00:05.000Z');
    await expect(store.defer(outboxKey(id, 1), 'x')).resolves.toBeUndefined();
    expect(await raw(id)).not.toHaveProperty('GSI2SK');
  });
});
