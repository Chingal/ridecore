import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { toEvent } from '../../src/domain/events.ts';
import type { Trip } from '../../src/domain/trip.ts';
import { reservationKey } from '../../src/infra/dynamo/keys.ts';
import { TripRepo } from '../../src/infra/dynamo/trip-repo.ts';
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

  it('reads only trips created since the run started, following every page', async () => {
    const repo = new TripRepo(doc, table);
    const trip = (createdAt: string): Trip => ({
      id: randomUUID(), passengerId: 'load-passenger-7', serviceType: 'STANDARD',
      origin: { lat: 2.45, lng: -76.47 }, destination: { lat: 2.46, lng: -76.46 },
      state: 'CANCELLED', fareEstimate: 7000, timestamps: { REQUESTED: createdAt }, version: 1, createdAt,
    });
    for (const at of ['2026-11-11T10:00:00.000Z', '2026-11-11T12:00:01.000Z', '2026-11-11T12:00:02.000Z', '2026-11-11T12:00:03.000Z']) {
      const t = trip(at);
      await repo.create({ ...t, state: 'REQUESTED' }, toEvent(null, { ...t, state: 'REQUESTED' }));
      // One active trip per passenger: drop the reservation so the next create is allowed.
      await doc.send(new DeleteCommand({ TableName: table, Key: reservationKey('PASSENGER', 'load-passenger-7') }));
    }
    const { read } = await collect({ table, env: {}, passengers: ['load-passenger-7'], drivers: [], waitMs: 0, since: '2026-11-11T12:00:00.000Z', pageSize: 1 });
    expect(read.trips).toBe(3);
  });
});
