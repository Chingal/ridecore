import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { toEvent } from '../../../src/domain/events.ts';
import { type Trip, transition } from '../../../src/domain/trip.ts';
import { TripRepo } from '../../../src/infra/dynamo/trip-repo.ts';

// Real DynamoDB reports every failed condition (Floci stops at the first), so the priority
// between codes is checked here with a stubbed client.
const trip: Trip = {
  id: 't1',
  passengerId: 'p1',
  serviceType: 'STANDARD',
  origin: { lat: 0, lng: 0 },
  destination: { lat: 1, lng: 1 },
  state: 'REQUESTED',
  fareEstimate: 5000,
  timestamps: { REQUESTED: '2026-11-09T12:00:00.000Z' },
  version: 1,
  createdAt: '2026-11-09T12:00:00.000Z',
};
const accepted = transition(trip, { type: 'ACCEPT', driverId: 'd1' }, { id: 'd1', role: 'driver' }, new Date());

function repoRejectingWith(codes: string[]): TripRepo {
  const err = new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
  const doc = { send: () => Promise.reject(err) } as unknown as DynamoDBDocumentClient;
  return new TripRepo(doc, 'stub');
}

describe('TripRepo cancellation-reason mapping', () => {
  // save(ACCEPTED) items: [trip, outbox, driver reservation]
  it('stale version wins over a busy driver', async () => {
    const repo = repoRejectingWith(['ConditionalCheckFailed', 'None', 'ConditionalCheckFailed']);
    await expect(repo.save(trip, accepted, toEvent(trip, accepted))).rejects.toMatchObject({
      code: 'CONCURRENT_UPDATE',
      status: 409,
    });
  });

  it('busy driver alone is DRIVER_BUSY', async () => {
    const repo = repoRejectingWith(['None', 'None', 'ConditionalCheckFailed']);
    await expect(repo.save(trip, accepted, toEvent(trip, accepted))).rejects.toMatchObject({ code: 'DRIVER_BUSY' });
  });

  // create items: [trip, passenger reservation, outbox]
  it('active passenger reservation wins over a trip id collision on create', async () => {
    const repo = repoRejectingWith(['ConditionalCheckFailed', 'ConditionalCheckFailed', 'None']);
    await expect(repo.create(trip, toEvent(null, trip))).rejects.toMatchObject({ code: 'ACTIVE_TRIP_EXISTS' });
  });

  it('TransactionConflict only is CONCURRENT_UPDATE', async () => {
    const repo = repoRejectingWith(['TransactionConflict', 'None', 'None']);
    await expect(repo.save(trip, accepted, toEvent(trip, accepted))).rejects.toMatchObject({
      code: 'CONCURRENT_UPDATE',
    });
  });

  it('rethrows non-transaction errors unchanged', async () => {
    const boom = new Error('network');
    const doc = { send: () => Promise.reject(boom) } as unknown as DynamoDBDocumentClient;
    await expect(new TripRepo(doc, 'stub').get('x')).rejects.toBe(boom);
  });
});
