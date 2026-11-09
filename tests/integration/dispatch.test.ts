import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatch, type Dispatch } from '../../src/app/dispatch.ts';
import { DomainError } from '../../src/domain/errors.ts';
import { toEvent } from '../../src/domain/events.ts';
import { type Actor, type LatLng, type Trip, transition, type TripAction } from '../../src/domain/trip.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
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

beforeAll(async () => {
  table = await createTestTable(client, 'dispatch');
  trips = new TripRepo(doc, table);
  drivers = new DriverRepo(doc, table);
  dispatch = createDispatch({ trips, drivers });
});

afterAll(async () => {
  await deleteTestTable(client, table);
});

const BASE = new Date('2026-11-09T12:00:00.000Z');

// The table is shared by every test in this file, so each test works in a different city:
// geohash-5 cells (~4.9 km) of cities 40+ km apart never overlap.
const POPAYAN: LatLng = { lat: 2.4448, lng: -76.6147 };
const CALI: LatLng = { lat: 3.4516, lng: -76.532 };
const PASTO: LatLng = { lat: 1.2136, lng: -77.2811 };
const NEIVA: LatLng = { lat: 2.9273, lng: -75.2819 };
const BOGOTA: LatLng = { lat: 4.711, lng: -74.0721 };
const MEDELLIN: LatLng = { lat: 6.2442, lng: -75.5812 };
const MANIZALES: LatLng = { lat: 5.0703, lng: -75.5138 };
const VILLAVICENCIO: LatLng = { lat: 4.142, lng: -73.6266 };
const BARRANQUILLA: LatLng = { lat: 10.9685, lng: -74.7813 };
const CARTAGENA: LatLng = { lat: 10.391, lng: -75.4794 };
const SANTA_MARTA: LatLng = { lat: 11.2408, lng: -74.199 };

/** A point `km` north of `p` (1 degree of latitude ~ 111.2 km). */
const north = (p: LatLng, km: number): LatLng => ({ lat: p.lat + km / 111.2, lng: p.lng });

async function seedDriver(position: LatLng | undefined, availability: 'AVAILABLE' | 'OFFLINE' = 'AVAILABLE'): Promise<string> {
  const id = `d-${randomUUID()}`;
  await drivers.upsert({
    id,
    name: `Driver ${id.slice(2, 8)}`,
    vehicle: { plate: 'ABC123', model: 'Logan 2019', category: 'STANDARD' },
    availability,
    ...(position === undefined ? {} : { position }),
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
    fareEstimate: 7600,
    timestamps: { REQUESTED: at },
    version: 1,
    createdAt: at,
  };
  await trips.create(trip, toEvent(null, trip));
  return trip;
}

/** Applies a plain transition (ARRIVE/START) through the trip repository. */
async function apply(trip: Trip, action: TripAction, actor: Actor): Promise<Trip> {
  const after = transition(trip, action, actor, BASE);
  await trips.save(trip, after, toEvent(trip, after));
  return after;
}

const asDriver = (id: string): Actor => ({ id, role: 'driver' });

async function rawItem(PK: string, SK: string): Promise<Record<string, unknown> | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { PK, SK }, ConsistentRead: true }));
  return res.Item;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

async function expectDomainError(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  const err = await rejection(promise);
  expect(err).toBeInstanceOf(DomainError);
  expect(err).toMatchObject({ code, status });
}

const nearIds = async (p: LatLng, limit = 10) => (await drivers.availableNear(p, limit)).map((d) => d.id);

describe('dispatch (DynamoDB on Floci)', () => {
  it('offerTrip offers the 5 nearest AVAILABLE drivers, nearest first, and records the offers', async () => {
    // Inserted out of distance order on purpose.
    const at22 = await seedDriver(north(POPAYAN, 2.2));
    const at03 = await seedDriver(north(POPAYAN, 0.3));
    const at30 = await seedDriver(north(POPAYAN, 3.0));
    const at08 = await seedDriver(north(POPAYAN, 0.8));
    const at15 = await seedDriver(north(POPAYAN, 1.5));
    const offline = await seedDriver(north(POPAYAN, 0.1), 'OFFLINE');
    const farAway = await seedDriver(north(POPAYAN, 30));
    const trip = await requestTrip(POPAYAN);

    const offered = await dispatch.offerTrip(trip.id);

    expect(offered).toEqual([at03, at08, at15, at22, at30]);
    expect(offered).not.toContain(offline);
    expect(offered).not.toContain(farAway);
    expect(await rawItem(`TRIP#${trip.id}`, `OFFER#${at03}`)).toMatchObject({
      tripId: trip.id,
      driverId: at03,
      GSI1PK: `DRIVER#${at03}`,
    });
    expect((await dispatch.listOffers(at08)).map((t) => t.id)).toEqual([trip.id]);
    expect(await dispatch.listOffers(farAway)).toEqual([]);
    expect(await dispatch.listOffers(offline)).toEqual([]);
  });

  it('availableNear honours the limit and a driver without a position is never indexed', async () => {
    const a = await seedDriver(north(MANIZALES, 0.5));
    const b = await seedDriver(north(MANIZALES, 1.0));
    const noPosition = await seedDriver(undefined);

    expect(await nearIds(MANIZALES, 1)).toEqual([a]);
    expect(await nearIds(MANIZALES)).toEqual([a, b]);
    expect(await rawItem(`DRIVER#${noPosition}`, 'META')).not.toHaveProperty('GSI2PK');
    expect(await drivers.get(noPosition)).toMatchObject({ availability: 'AVAILABLE' });
  });

  it('setPosition and setAvailability keep the availability index in sync', async () => {
    const d = await seedDriver(undefined, 'OFFLINE');
    await drivers.setPosition(d, north(MEDELLIN, 0.4));
    expect(await nearIds(MEDELLIN)).toEqual([]);

    await drivers.setAvailability(d, 'AVAILABLE');
    expect(await nearIds(MEDELLIN)).toEqual([d]);

    await drivers.setPosition(d, north(MEDELLIN, 40));
    expect(await nearIds(MEDELLIN)).toEqual([]);
    expect(await nearIds(north(MEDELLIN, 40))).toEqual([d]);

    await drivers.setAvailability(d, 'OFFLINE');
    expect(await nearIds(north(MEDELLIN, 40))).toEqual([]);
    expect(await rawItem(`DRIVER#${d}`, 'META')).not.toHaveProperty('GSI2PK');

    await expectDomainError(drivers.setAvailability(`d-${randomUUID()}`, 'AVAILABLE'), 'DRIVER_NOT_FOUND', 404);
  });

  it('offerTrip rejects an unknown trip (404) and a trip that is no longer REQUESTED (409)', async () => {
    await expectDomainError(dispatch.offerTrip(randomUUID()), 'TRIP_NOT_FOUND', 404);

    const d = await seedDriver(north(NEIVA, 0.5));
    const trip = await requestTrip(NEIVA);
    await dispatch.offerTrip(trip.id);
    await dispatch.acceptTrip(trip.id, asDriver(d), BASE);
    await expectDomainError(dispatch.offerTrip(trip.id), 'INVALID_TRANSITION', 409);
  });

  it('accept by a driver who was not offered the trip -> 404 NOT_OFFERED, nothing written', async () => {
    const offeredDriver = await seedDriver(north(CALI, 0.5));
    const stranger = await seedDriver(north(CALI, 30)); // AVAILABLE, just not offered
    const trip = await requestTrip(CALI);
    expect(await dispatch.offerTrip(trip.id)).toEqual([offeredDriver]);

    await expectDomainError(dispatch.acceptTrip(trip.id, asDriver(stranger), BASE), 'NOT_OFFERED', 404);
    expect(await trips.get(trip.id)).toEqual(trip);
    expect(await drivers.get(stranger)).toMatchObject({ availability: 'AVAILABLE' });
    expect(await trips.activeTripId('DRIVER', stranger)).toBeNull();
  });

  it('accept by an offered driver who went OFFLINE -> 409 DRIVER_NOT_AVAILABLE, nothing written', async () => {
    const d = await seedDriver(north(PASTO, 0.5));
    const trip = await requestTrip(PASTO);
    expect(await dispatch.offerTrip(trip.id)).toEqual([d]);
    await drivers.setAvailability(d, 'OFFLINE');

    await expectDomainError(dispatch.acceptTrip(trip.id, asDriver(d), BASE), 'DRIVER_NOT_AVAILABLE', 409);
    expect(await trips.get(trip.id)).toEqual(trip);
    expect(await drivers.get(d)).toMatchObject({ availability: 'OFFLINE' });
    expect(await trips.activeTripId('DRIVER', d)).toBeNull();
    expect(await rawItem(`TRIP#${trip.id}`, 'EVENT#000002')).toBeUndefined();
  });

  it('accept of a second offered trip by a driver already on a trip -> 409 DRIVER_BUSY, nothing written', async () => {
    const d = await seedDriver(north(CARTAGENA, 0.5));
    const first = await requestTrip(CARTAGENA);
    const second = await requestTrip(CARTAGENA);
    expect(await dispatch.offerTrip(first.id)).toEqual([d]);
    expect(await dispatch.offerTrip(second.id)).toEqual([d]);
    expect((await dispatch.listOffers(d)).map((t) => t.id).sort()).toEqual([first.id, second.id].sort());

    await dispatch.acceptTrip(first.id, asDriver(d), BASE);
    expect((await dispatch.listOffers(d)).map((t) => t.id)).toEqual([second.id]);

    await expectDomainError(dispatch.acceptTrip(second.id, asDriver(d), BASE), 'DRIVER_BUSY', 409);
    expect(await trips.get(second.id)).toEqual(second);
    expect(await trips.activeTripId('DRIVER', d)).toBe(first.id);
    expect(await drivers.get(d)).toMatchObject({ availability: 'ON_TRIP' });
  });

  it('Review Focus 1 at service level: two offered drivers accept concurrently -> one wins, loser stays AVAILABLE', async () => {
    const d1 = await seedDriver(north(BOGOTA, 0.5));
    const d2 = await seedDriver(north(BOGOTA, 0.9));
    const trip = await requestTrip(BOGOTA);
    expect(await dispatch.offerTrip(trip.id)).toEqual([d1, d2]);

    const results = await Promise.allSettled([
      dispatch.acceptTrip(trip.id, asDriver(d1), BASE),
      dispatch.acceptTrip(trip.id, asDriver(d2), BASE),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DomainError);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CONCURRENT_UPDATE', status: 409 });

    const winner = results[0]?.status === 'fulfilled' ? d1 : d2;
    const loser = winner === d1 ? d2 : d1;
    expect(fulfilled[0]?.value).toMatchObject({ state: 'ACCEPTED', driverId: winner, version: 2 });
    expect(await trips.get(trip.id)).toMatchObject({ state: 'ACCEPTED', driverId: winner, version: 2 });

    expect(await drivers.get(winner)).toMatchObject({ availability: 'ON_TRIP' });
    expect(await rawItem(`DRIVER#${winner}`, 'META')).not.toHaveProperty('GSI2PK');
    expect(await trips.activeTripId('DRIVER', winner)).toBe(trip.id);

    expect(await drivers.get(loser)).toMatchObject({ availability: 'AVAILABLE' });
    expect(await rawItem(`DRIVER#${loser}`, 'META')).toHaveProperty('GSI2PK');
    expect(await trips.activeTripId('DRIVER', loser)).toBeNull();
    expect(await nearIds(BOGOTA)).toEqual([loser]);

    // The accepted trip is no longer listed as an offer, and an on-trip driver cannot go offline.
    expect(await dispatch.listOffers(loser)).toEqual([]);
    await expectDomainError(drivers.setAvailability(winner, 'OFFLINE'), 'DRIVER_ON_TRIP', 409);
  });

  it('after COMPLETE the driver is AVAILABLE again and reappears in availableNear', async () => {
    const origin = VILLAVICENCIO;
    const d = await seedDriver(north(origin, 0.6));
    let trip = await requestTrip(origin);
    await dispatch.offerTrip(trip.id);
    trip = await dispatch.acceptTrip(trip.id, asDriver(d), BASE);
    expect(await nearIds(origin)).toEqual([]);

    trip = await apply(trip, { type: 'ARRIVE' }, asDriver(d));
    trip = await apply(trip, { type: 'START' }, asDriver(d));
    const done = await dispatch.finishTrip(trip.id, { type: 'COMPLETE' }, asDriver(d), BASE);

    expect(done).toMatchObject({ state: 'COMPLETED', driverId: d, version: 5 });
    expect(await trips.get(trip.id)).toEqual(done);
    expect(await drivers.get(d)).toMatchObject({ availability: 'AVAILABLE' });
    expect(await nearIds(origin)).toEqual([d]);
    expect(await trips.activeTripId('DRIVER', d)).toBeNull();
    expect(await trips.activeTripId('PASSENGER', trip.passengerId)).toBeNull();
  });

  it('CANCEL after ACCEPT releases the driver too; CANCEL from REQUESTED touches no driver', async () => {
    const origin = BARRANQUILLA;
    const d = await seedDriver(north(origin, 0.6));
    const trip = await requestTrip(origin);
    await dispatch.offerTrip(trip.id);
    await dispatch.acceptTrip(trip.id, asDriver(d), BASE);

    const cancelled = await dispatch.finishTrip(trip.id, { type: 'CANCEL', reason: 'flat tyre' }, asDriver(d), BASE);
    expect(cancelled).toMatchObject({ state: 'CANCELLED', cancellation: { by: 'driver', reason: 'flat tyre' } });
    expect(await drivers.get(d)).toMatchObject({ availability: 'AVAILABLE' });
    expect(await nearIds(origin)).toEqual([d]);

    const other = await requestTrip(origin);
    const passenger: Actor = { id: other.passengerId, role: 'passenger' };
    expect(await dispatch.finishTrip(other.id, { type: 'CANCEL' }, passenger, BASE)).toMatchObject({ state: 'CANCELLED' });
    await expectDomainError(dispatch.finishTrip(randomUUID(), { type: 'CANCEL' }, passenger, BASE), 'TRIP_NOT_FOUND', 404);
  });
  it('listOffers still finds an older pending offer behind 50 newer terminal offers', async () => {
    const d = await seedDriver(north(SANTA_MARTA, 0.5));
    const pending = await requestTrip(SANTA_MARTA);
    expect(await dispatch.offerTrip(pending.id, BASE)).toEqual([d]);

    for (let i = 1; i <= 50; i++) {
      const trip = await requestTrip(SANTA_MARTA);
      expect(await dispatch.offerTrip(trip.id, new Date(BASE.getTime() + i * 1000))).toEqual([d]);
      await dispatch.finishTrip(trip.id, { type: 'CANCEL' }, { id: trip.passengerId, role: 'passenger' }, BASE);
    }

    expect((await dispatch.listOffers(d)).map((t) => t.id)).toEqual([pending.id]);
  });
});
