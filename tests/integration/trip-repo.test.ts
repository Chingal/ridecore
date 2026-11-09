import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.ts';
import { toEvent } from '../../src/domain/events.ts';
import { type Actor, type Trip, transition, type TripAction } from '../../src/domain/trip.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { TripRepo } from '../../src/infra/dynamo/trip-repo.ts';
import { createTestTable, deleteTestTable, useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const client = createDynamoClient();
const doc = createDocumentClient(client);
let table: string;
let repo: TripRepo;

beforeAll(async () => {
  table = await createTestTable(client, 'trip-repo');
  repo = new TripRepo(doc, table);
});

afterAll(async () => {
  await deleteTestTable(client, table);
});

const BASE = new Date('2026-11-09T12:00:00.000Z');

function newTrip(passengerId: string, createdAt: Date = BASE): Trip {
  const at = createdAt.toISOString();
  return {
    id: randomUUID(),
    passengerId,
    serviceType: 'STANDARD',
    origin: { lat: 2.4448, lng: -76.6147 },
    destination: { lat: 2.4596, lng: -76.6004 },
    state: 'REQUESTED',
    fareEstimate: 7000,
    timestamps: { REQUESTED: at },
    version: 1,
    createdAt: at,
  };
}

async function createTrip(passengerId = `p-${randomUUID()}`, createdAt?: Date): Promise<Trip> {
  const trip = newTrip(passengerId, createdAt);
  await repo.create(trip, toEvent(null, trip));
  return trip;
}

/** Applies a domain transition and persists it; returns the new trip. */
async function apply(trip: Trip, action: TripAction, actor: Actor): Promise<Trip> {
  const after = transition(trip, action, actor, new Date(BASE.getTime() + trip.version * 60_000));
  await repo.save(trip, after, toEvent(trip, after));
  return after;
}

const driver = (id: string): Actor => ({ id, role: 'driver' });
const passenger = (trip: Trip): Actor => ({ id: trip.passengerId, role: 'passenger' });

async function rawItem(PK: string, SK: string): Promise<Record<string, unknown> | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { PK, SK }, ConsistentRead: true }));
  return res.Item;
}

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect(err).toMatchObject({ code, status: 409 });
}

describe('TripRepo (DynamoDB on Floci)', () => {
  it('create then get round-trips the trip and writes outbox EVENT#000001', async () => {
    const trip = await createTrip();

    expect(await repo.get(trip.id)).toEqual(trip);
    const outbox = await rawItem(`TRIP#${trip.id}`, 'EVENT#000001');
    expect(outbox).toMatchObject({ type: 'trip.requested', tripId: trip.id, version: 1, eventId: `${trip.id}:1` });
    expect(await repo.activeTripId('PASSENGER', trip.passengerId)).toBe(trip.id);
  });

  it('get returns null for an unknown trip', async () => {
    expect(await repo.get(randomUUID())).toBeNull();
  });

  it('rejects a second create for a passenger with an active trip (409 ACTIVE_TRIP_EXISTS)', async () => {
    const first = await createTrip();
    const second = newTrip(first.passengerId);

    await expectDomainError(repo.create(second, toEvent(null, second)), 'ACTIVE_TRIP_EXISTS');
    expect(await repo.get(second.id)).toBeNull();
    expect(await rawItem(`TRIP#${second.id}`, 'EVENT#000001')).toBeUndefined();
    expect(await repo.activeTripId('PASSENGER', first.passengerId)).toBe(first.id);
  });

  it('rejects save with a stale before.version (409 CONCURRENT_UPDATE)', async () => {
    const trip = await createTrip();
    await apply(trip, { type: 'ACCEPT', driverId: 'd-stale-1' }, driver('d-stale-1'));

    // `trip` is now stale (version 1 while the stored trip is at version 2).
    const stale = transition(trip, { type: 'CANCEL' }, passenger(trip), BASE);
    await expectDomainError(repo.save(trip, stale, toEvent(trip, stale)), 'CONCURRENT_UPDATE');
    expect(await repo.get(trip.id)).toMatchObject({ state: 'ACCEPTED', version: 2 });
  });

  it('rejects ACCEPT by a driver who already has an active trip (409 DRIVER_BUSY)', async () => {
    const d = `d-${randomUUID()}`;
    const first = await createTrip();
    await apply(first, { type: 'ACCEPT', driverId: d }, driver(d));

    const second = await createTrip();
    const accepted = transition(second, { type: 'ACCEPT', driverId: d }, driver(d), BASE);
    await expectDomainError(repo.save(second, accepted, toEvent(second, accepted)), 'DRIVER_BUSY');
    expect(await repo.get(second.id)).toMatchObject({ state: 'REQUESTED', version: 1 });
    expect(await repo.activeTripId('DRIVER', d)).toBe(first.id);
  });

  it('Review Focus 1: two concurrent ACCEPTs of the same trip -> exactly one wins', async () => {
    const trip = await createTrip();
    const d1 = `d1-${randomUUID()}`;
    const d2 = `d2-${randomUUID()}`;

    const results = await Promise.allSettled([
      apply(trip, { type: 'ACCEPT', driverId: d1 }, driver(d1)),
      apply(trip, { type: 'ACCEPT', driverId: d2 }, driver(d2)),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CONCURRENT_UPDATE', status: 409 });

    const winner = results[0]?.status === 'fulfilled' ? d1 : d2;
    const loser = winner === d1 ? d2 : d1;
    expect(await repo.activeTripId('DRIVER', winner)).toBe(trip.id);
    expect(await rawItem(`DRIVER#${loser}`, 'ACTIVE')).toBeUndefined();
    expect(await repo.get(trip.id)).toMatchObject({ state: 'ACCEPTED', driverId: winner, version: 2 });
  });

  it('Review Focus 2: concurrent ACCEPT and passenger CANCEL from REQUESTED -> exactly one wins', async () => {
    const trip = await createTrip();
    const d1 = `d1-${randomUUID()}`;

    const [accept, cancel] = await Promise.allSettled([
      apply(trip, { type: 'ACCEPT', driverId: d1 }, driver(d1)),
      apply(trip, { type: 'CANCEL', reason: 'changed my mind' }, passenger(trip)),
    ]);

    expect([accept?.status, cancel?.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
    const stored = await repo.get(trip.id);
    if (cancel?.status === 'fulfilled') {
      expect(accept).toMatchObject({ status: 'rejected', reason: { code: 'CONCURRENT_UPDATE' } });
      expect(stored).toMatchObject({ state: 'CANCELLED', version: 2 });
      expect(await rawItem(`PASSENGER#${trip.passengerId}`, 'ACTIVE')).toBeUndefined();
      expect(await rawItem(`DRIVER#${d1}`, 'ACTIVE')).toBeUndefined();
    } else {
      expect(cancel).toMatchObject({ status: 'rejected', reason: { code: 'CONCURRENT_UPDATE' } });
      expect(stored).toMatchObject({ state: 'ACCEPTED', driverId: d1, version: 2 });
      expect(await repo.activeTripId('PASSENGER', trip.passengerId)).toBe(trip.id);
      expect(await repo.activeTripId('DRIVER', d1)).toBe(trip.id);
    }
  });

  it('completing a trip deletes both reservations and the passenger can create a new trip', async () => {
    const d = `d-${randomUUID()}`;
    let trip = await createTrip();
    trip = await apply(trip, { type: 'ACCEPT', driverId: d }, driver(d));
    trip = await apply(trip, { type: 'ARRIVE' }, driver(d));
    trip = await apply(trip, { type: 'START' }, driver(d));
    trip = await apply(trip, { type: 'COMPLETE' }, driver(d));

    expect(await repo.get(trip.id)).toEqual(trip);
    expect(await repo.activeTripId('PASSENGER', trip.passengerId)).toBeNull();
    expect(await repo.activeTripId('DRIVER', d)).toBeNull();
    expect(await rawItem(`TRIP#${trip.id}`, 'EVENT#000005')).toMatchObject({ type: 'trip.completed' });

    const next = await createTrip(trip.passengerId);
    expect(await repo.activeTripId('PASSENGER', trip.passengerId)).toBe(next.id);
  });

  it('cancel by the driver after ACCEPT releases both reservations', async () => {
    const d = `d-${randomUUID()}`;
    let trip = await createTrip();
    trip = await apply(trip, { type: 'ACCEPT', driverId: d }, driver(d));
    trip = await apply(trip, { type: 'CANCEL' }, driver(d));

    expect(trip.state).toBe('CANCELLED');
    expect(await repo.activeTripId('PASSENGER', trip.passengerId)).toBeNull();
    expect(await repo.activeTripId('DRIVER', d)).toBeNull();
  });

  it('save accepts extra transaction items and writes them atomically', async () => {
    const trip = await createTrip();
    const d = `d-${randomUUID()}`;
    const after = transition(trip, { type: 'ACCEPT', driverId: d }, driver(d), BASE);
    const extra = { Put: { TableName: table, Item: { PK: `DRIVERSTATUS#${d}`, SK: 'META', status: 'ON_TRIP' } } };

    expect(repo.buildSaveItems(trip, after, toEvent(trip, after))).toHaveLength(3);
    await repo.save(trip, after, toEvent(trip, after), [extra]);
    expect(await rawItem(`DRIVERSTATUS#${d}`, 'META')).toMatchObject({ status: 'ON_TRIP' });

    const failing = {
      ConditionCheck: { TableName: table, Key: { PK: 'NOPE', SK: 'NOPE' }, ConditionExpression: 'attribute_exists(PK)' },
    };
    const next = transition(after, { type: 'ARRIVE' }, driver(d), BASE);
    await expectDomainError(repo.save(after, next, toEvent(after, next), [failing]), 'CONCURRENT_UPDATE');
    expect(await repo.get(trip.id)).toMatchObject({ state: 'ACCEPTED', version: 2 });
  });

  it('history returns the passenger trips newest first, honouring the limit', async () => {
    const p = `p-${randomUUID()}`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const trip = await createTrip(p, new Date(BASE.getTime() + i * 3_600_000));
      ids.push(trip.id);
      await apply(trip, { type: 'CANCEL' }, passenger(trip));
    }

    const all = await repo.history(p);
    expect(all.map((t) => t.id)).toEqual([...ids].reverse());
    expect(all.every((t) => t.state === 'CANCELLED')).toBe(true);
    expect((await repo.history(p, 2)).map((t) => t.id)).toEqual([ids[2], ids[1]]);

    const other = await doc.send(
      new QueryCommand({
        TableName: table,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `PASSENGER#${p}` },
      }),
    );
    expect(other.Items).toHaveLength(3);
  });
});
