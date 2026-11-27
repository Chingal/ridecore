import { describe, expect, it } from 'vitest';
import { createDispatch } from '../../../src/app/dispatch.ts';
import type { Actor, Trip, TripState } from '../../../src/domain/trip.ts';
import type { DriverRepo } from '../../../src/infra/dynamo/driver-repo.ts';
import type { TripRepo } from '../../../src/infra/dynamo/trip-repo.ts';

const DRIVER_ID = 'drv-1';
// Deliberately different from the driver id, so passing the driver id in its place would be caught.
const TRIP_ID = 'trip-xyz';

const tripIn = (state: TripState): Trip => ({
  id: TRIP_ID,
  passengerId: 'p1',
  ...(state === 'REQUESTED' ? {} : { driverId: DRIVER_ID }),
  serviceType: 'STANDARD',
  origin: { lat: 2.45, lng: -76.47 },
  destination: { lat: 2.46, lng: -76.47 },
  state,
  fareEstimate: 7600,
  timestamps: { REQUESTED: '2026-11-11T12:00:00.000Z' },
  version: 1,
  createdAt: '2026-11-11T12:00:00.000Z',
});

/** Stubbed repositories (as in tests/unit/app/dispatch-location.test.ts) that record the ids passed. */
function setup(before: Trip) {
  const taken: Array<[string, string]> = [];
  const released: Array<[string, string]> = [];
  const trips = {
    getWithOffers: async () => ({ trip: before, offers: { seq: 0, driverIds: [DRIVER_ID] } }),
    save: async () => {},
  } as unknown as TripRepo;
  const drivers = {
    retireOfferItems: () => [],
    takeTripItem: (driverId: string, tripId: string) => {
      taken.push([driverId, tripId]);
      return { item: { Update: { TableName: 'stub', Key: {} } } };
    },
    releaseItems: async (driverId: string, tripId: string) => {
      released.push([driverId, tripId]);
      return [];
    },
  } as unknown as DriverRepo;
  return { dispatch: createDispatch({ trips, drivers }), taken, released };
}

describe('createDispatch binds the driver item to the trip', () => {
  // Criterion 6.
  it('accept and finish pass the trip id to the driver items', async () => {
    const now = new Date('2026-11-11T12:30:00.000Z');
    const driver: Actor = { id: DRIVER_ID, role: 'driver' };

    const accept = setup(tripIn('REQUESTED'));
    await accept.dispatch.acceptTrip(TRIP_ID, driver, now);
    expect(accept.taken).toEqual([[DRIVER_ID, TRIP_ID]]);
    expect(accept.released).toEqual([]);

    const complete = setup(tripIn('IN_PROGRESS'));
    await complete.dispatch.finishTrip(TRIP_ID, { type: 'COMPLETE' }, driver, now);
    expect(complete.released).toEqual([[DRIVER_ID, TRIP_ID]]);

    const cancel = setup(tripIn('ACCEPTED'));
    await cancel.dispatch.finishTrip(TRIP_ID, { type: 'CANCEL', reason: 'flat tyre' }, driver, now);
    expect(cancel.released).toEqual([[DRIVER_ID, TRIP_ID]]);
  });
});
