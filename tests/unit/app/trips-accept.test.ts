import { describe, expect, it } from 'vitest';
import type { Dispatch } from '../../../src/app/dispatch.ts';
import { createTripService } from '../../../src/app/trips.ts';
import { DomainError } from '../../../src/domain/errors.ts';
import { type Trip, transition } from '../../../src/domain/trip.ts';
import type { DriverRepo } from '../../../src/infra/dynamo/driver-repo.ts';
import type { TripRepo } from '../../../src/infra/dynamo/trip-repo.ts';

const now = new Date('2026-11-09T12:00:00.000Z');
const requested: Trip = {
  id: '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  passengerId: 'p1',
  serviceType: 'STANDARD',
  origin: { lat: 0, lng: 0 },
  destination: { lat: 1, lng: 1 },
  state: 'REQUESTED',
  fareEstimate: 5000,
  timestamps: { REQUESTED: now.toISOString() },
  version: 1,
  createdAt: now.toISOString(),
};
const me = { id: 'd-me', role: 'driver' as const };
const other = { id: 'd-other', role: 'driver' as const };
const takenByOther = transition(requested, { type: 'ACCEPT', driverId: other.id }, other, now);

/** The accept tie: both drivers read REQUESTED with their offer; the other driver's transaction commits first. */
function service(raceError: DomainError) {
  const trips = {
    getWithOffers: async () => ({ trip: requested, offers: { seq: 1, driverIds: [me.id, other.id] } }),
    get: async () => takenByOther,
  } as unknown as TripRepo;
  const dispatch = {
    acceptTrip: async () => {
      throw raceError;
    },
  } as unknown as Dispatch;
  return createTripService({ trips, drivers: {} as DriverRepo, dispatch });
}

describe('acceptTrip loser of a simultaneous accept', () => {
  it('a version conflict (CONCURRENT_UPDATE) becomes 409 TRIP_ALREADY_TAKEN once another driver is assigned', async () => {
    const svc = service(new DomainError('CONCURRENT_UPDATE', 409, 'The trip was modified concurrently'));
    await expect(svc.acceptTrip(me, { tripId: requested.id }, now)).rejects.toMatchObject({
      code: 'TRIP_ALREADY_TAKEN',
      status: 409,
    });
  });

  it('a retired offer (NOT_OFFERED) is also TRIP_ALREADY_TAKEN', async () => {
    const svc = service(new DomainError('NOT_OFFERED', 404, 'not offered'));
    await expect(svc.acceptTrip(me, { tripId: requested.id }, now)).rejects.toMatchObject({ code: 'TRIP_ALREADY_TAKEN' });
  });

  it('other errors pass through unchanged', async () => {
    const busy = new DomainError('DRIVER_NOT_AVAILABLE', 409, 'not available');
    await expect(service(busy).acceptTrip(me, { tripId: requested.id }, now)).rejects.toBe(busy);
  });
});
