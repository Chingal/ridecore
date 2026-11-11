import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatch, type Dispatch } from '../../src/app/dispatch.ts';
import { DomainError } from '../../src/domain/errors.ts';
import { toEvent } from '../../src/domain/events.ts';
import { type LatLng, type Trip, transition } from '../../src/domain/trip.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { ConsumedRepo } from '../../src/infra/dynamo/consumed-repo.ts';
import { DriverRepo } from '../../src/infra/dynamo/driver-repo.ts';
import { TripRepo } from '../../src/infra/dynamo/trip-repo.ts';
import { createTestTable, deleteTestTable, useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const client = createDynamoClient();
const doc = createDocumentClient(client);
let table: string;
let trips: TripRepo;
let drivers: DriverRepo;
let dispatch: Dispatch;
let consumed: ConsumedRepo;

beforeAll(async () => {
  table = await createTestTable(client, 'consumers');
  trips = new TripRepo(doc, table);
  drivers = new DriverRepo(doc, table);
  dispatch = createDispatch({ trips, drivers });
  consumed = new ConsumedRepo(doc, table);
});

afterAll(async () => {
  await deleteTestTable(client, table);
});

const BASE = new Date('2026-11-10T12:00:00.000Z');
// One city per test (geohash-5 cells of cities 40+ km apart never overlap).
const POPAYAN: LatLng = { lat: 2.4448, lng: -76.6147 };
const CALI: LatLng = { lat: 3.4516, lng: -76.532 };
const PASTO: LatLng = { lat: 1.2136, lng: -77.2811 };
const NEIVA: LatLng = { lat: 2.9273, lng: -75.2819 };
const north = (p: LatLng, km: number): LatLng => ({ lat: p.lat + km / 111.2, lng: p.lng });

async function seedDriver(position: LatLng): Promise<string> {
  const id = `d-${randomUUID()}`;
  await drivers.upsert({
    id,
    name: `Driver ${id.slice(2, 8)}`,
    vehicle: { plate: 'ABC123', model: 'Logan 2019', category: 'STANDARD' },
    availability: 'AVAILABLE',
    position,
  });
  return id;
}

async function requestTrip(origin: LatLng): Promise<Trip> {
  const at = BASE.toISOString();
  const trip: Trip = {
    id: randomUUID(),
    passengerId: `p-${randomUUID()}`,
    serviceType: 'STANDARD',
    origin,
    destination: north(origin, 2),
    state: 'REQUESTED',
    fareEstimate: 7000,
    timestamps: { REQUESTED: at },
    version: 1,
    createdAt: at,
  };
  await trips.create(trip, toEvent(null, trip));
  return trip;
}

async function offerItems(tripId: string): Promise<string[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :offer)',
      ExpressionAttributeValues: { ':pk': `TRIP#${tripId}`, ':offer': 'OFFER#' },
      ConsistentRead: true,
    }),
  );
  return (res.Items ?? []).map((i) => String(i.driverId)).sort();
}

describe('dispatch.offerTripOnce (DynamoDB on Floci)', () => {
  it('offers a fresh trip once; a second call returns the recorded offers without offering more', async () => {
    const near1 = await seedDriver(north(POPAYAN, 0.2));
    const near2 = await seedDriver(north(POPAYAN, 0.4));
    const trip = await requestTrip(POPAYAN);

    const first = await dispatch.offerTripOnce(trip.id);
    expect(first).toEqual({ driverIds: [near1, near2], fresh: true });

    await seedDriver(north(POPAYAN, 0.1)); // a new nearby driver must not get this trip on redelivery
    const second = await dispatch.offerTripOnce(trip.id);
    expect({ ...second, driverIds: [...second.driverIds].sort() }).toEqual({ driverIds: [near1, near2].sort(), fresh: false });
    expect(await offerItems(trip.id)).toEqual([near1, near2].sort());
  });

  it('two concurrent calls record the offers once and both return them', async () => {
    const ids = [await seedDriver(north(CALI, 0.2)), await seedDriver(north(CALI, 0.5)), await seedDriver(north(CALI, 0.9))];
    const trip = await requestTrip(CALI);

    const [a, b] = await Promise.all([dispatch.offerTripOnce(trip.id), dispatch.offerTripOnce(trip.id)]);

    expect([...a.driverIds].sort()).toEqual([...ids].sort());
    expect([...b.driverIds].sort()).toEqual([...ids].sort());
    expect([a.fresh, b.fresh].filter(Boolean)).toHaveLength(1);
    expect(await offerItems(trip.id)).toEqual([...ids].sort());
  });

  it('a trip that is no longer REQUESTED is not offered (late or out-of-order event)', async () => {
    await seedDriver(north(PASTO, 0.3));
    const trip = await requestTrip(PASTO);
    const cancelled = transition(trip, { type: 'CANCEL', reason: 'changed my mind' }, { id: trip.passengerId, role: 'passenger' }, BASE);
    await trips.save(trip, cancelled, toEvent(trip, cancelled));

    expect(await dispatch.offerTripOnce(trip.id)).toEqual({ driverIds: [], fresh: false });
    expect(await offerItems(trip.id)).toEqual([]);
  });

  it('a cancelled offer write that nobody else won is an error (the event is retried), not an empty success', async () => {
    const MEDELLIN: LatLng = { lat: 6.2442, lng: -75.5812 };
    await seedDriver(north(MEDELLIN, 0.3));
    const trip = await requestTrip(MEDELLIN);
    const flaky = Object.create(drivers) as DriverRepo;
    flaky.putOffers = () => Promise.reject(new DomainError('CONCURRENT_UPDATE', 409, 'transaction cancelled'));
    const failing = createDispatch({ trips, drivers: flaky });

    await expect(failing.offerTripOnce(trip.id)).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE' });
    expect(await offerItems(trip.id)).toEqual([]);
  });

  it('with no AVAILABLE driver nearby nothing is offered and nothing fails', async () => {
    const trip = await requestTrip(NEIVA);
    expect(await dispatch.offerTripOnce(trip.id)).toEqual({ driverIds: [], fresh: true });
    expect(await offerItems(trip.id)).toEqual([]);
  });
});

describe('ConsumedRepo (DynamoDB on Floci)', () => {
  it('markOnce is true the first time and false for the same consumer and event afterwards', async () => {
    const eventId = `${randomUUID()}:1`;
    expect(await consumed.markOnce('driver-offers', eventId, BASE)).toBe(true);
    expect(await consumed.markOnce('driver-offers', eventId, BASE)).toBe(false);
    expect(await consumed.markOnce('billing', eventId, BASE)).toBe(true);

    const item = await doc.send(
      new GetCommand({ TableName: table, Key: { PK: 'CONSUMED#driver-offers', SK: `EVENT#${eventId}` }, ConsistentRead: true }),
    );
    expect(item.Item?.expiresAt).toBe(Math.floor(BASE.getTime() / 1000) + 7 * 24 * 60 * 60);
  });
});
