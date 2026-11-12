import { describe, expect, it } from 'vitest';
import { createDispatch, type NearbySource } from '../../../src/app/dispatch.ts';
import type { Trip } from '../../../src/domain/trip.ts';
import type { DriverRepo } from '../../../src/infra/dynamo/driver-repo.ts';
import { LocationUnavailableError } from '../../../src/infra/location/client.ts';
import type { TripRepo } from '../../../src/infra/dynamo/trip-repo.ts';

const trip: Trip = {
  id: 't1',
  passengerId: 'p1',
  serviceType: 'STANDARD',
  origin: { lat: 2.45, lng: -76.47 },
  destination: { lat: 2.46, lng: -76.47 },
  state: 'REQUESTED',
  fareEstimate: 7600,
  timestamps: { REQUESTED: '2026-11-11T12:00:00.000Z' },
  version: 1,
  createdAt: '2026-11-11T12:00:00.000Z',
};

function setup(nearby: NearbySource) {
  const offered: string[][] = [];
  const trips = { getWithOffers: async () => ({ trip, offers: { seq: 0, driverIds: [] } }) } as unknown as TripRepo;
  const drivers = {
    availableNear: async () => {
      throw new Error('the DynamoDB index must not be read when a nearby source is given');
    },
    putOffers: async (_t: string, ids: string[]) => void offered.push(ids),
  } as unknown as DriverRepo;
  return { dispatch: createDispatch({ trips, drivers, nearby }), offered };
}

describe('dispatch with a nearby source', () => {
  it('offers to the drivers the source returns', async () => {
    const { dispatch, offered } = setup({ availableNear: async () => [{ id: 'd2' }, { id: 'd4' }] });
    await expect(dispatch.offerTripOnce('t1')).resolves.toEqual({ driverIds: ['d2', 'd4'], fresh: true });
    expect(offered).toEqual([['d2', 'd4']]);
  });

  // Review Focus 1: the location service down must fail the message (SQS retries it), never record "nobody near".
  it('propagates a location failure and writes no offer', async () => {
    const down = new LocationUnavailableError('down');
    const { dispatch, offered } = setup({
      availableNear: async () => {
        throw down;
      },
    });
    await expect(dispatch.offerTripOnce('t1')).rejects.toBe(down);
    await expect(dispatch.offerTrip('t1')).rejects.toBe(down);
    expect(offered).toEqual([]);
  });
});
