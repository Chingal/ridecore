import { describe, expect, it } from 'vitest';
import type { Trip, TripState } from '../../../src/domain/trip.ts';
import { evaluate, exitCode, queueUrls, requiredQueueCount, type Snapshot } from '../../../scripts/load/check.ts';

const trip = (id: string, state: TripState, version: number, over: Partial<Trip> = {}): Trip =>
  ({ id, passengerId: 'load-passenger-1', state, version, ...over }) as Trip;

/** A consistent snapshot: one active trip with its reservations, one completed and billed. */
function clean(): Snapshot {
  return {
    trips: [trip('t-active', 'ACCEPTED', 2, { driverId: 'load-driver-1' }), trip('t-done', 'RATED', 6, { passengerId: 'load-passenger-2', driverId: 'load-driver-2' })],
    reservations: [
      { kind: 'PASSENGER', id: 'load-passenger-1', tripId: 't-active' },
      { kind: 'PASSENGER', id: 'load-passenger-2', tripId: null },
      { kind: 'DRIVER', id: 'load-driver-1', tripId: 't-active' },
      { kind: 'DRIVER', id: 'load-driver-2', tripId: null },
    ],
    drivers: [
      { id: 'load-driver-1', availability: 'ON_TRIP' },
      { id: 'load-driver-2', availability: 'AVAILABLE' },
    ],
    billed: new Set(['t-done']),
    eventVersions: new Map([
      ['t-active', [1, 2]],
      ['t-done', [1, 2, 3, 4, 5, 6]],
    ]),
    queues: [
      { name: 'billing', visible: 0, inFlight: 0, dlq: false },
      { name: 'billing-dlq', visible: 1, inFlight: 0, dlq: true },
    ],
    baselineDlq: { 'billing-dlq': 1 },
  };
}

describe('evaluate', () => {
  it('a consistent snapshot has no violations (a DLQ message from before the run is not one)', () => {
    expect(evaluate(clean())).toEqual([]);
  });

  it('1. a reservation pointing to a finished or missing trip, and an active trip without its reservations', () => {
    const s = clean();
    s.reservations[1] = { kind: 'PASSENGER', id: 'load-passenger-2', tripId: 't-done' };
    s.reservations[2] = { kind: 'DRIVER', id: 'load-driver-1', tripId: 't-ghost' };
    const v = evaluate(s);
    expect(v).toContain('reservation PASSENGER#load-passenger-2 points to trip t-done in state RATED');
    expect(v).toContain('reservation DRIVER#load-driver-1 points to trip t-ghost, which does not exist');
    expect(v).toContain('active trip t-active has no DRIVER reservation for load-driver-1');
  });

  it("1b. a reservation that points to someone else's trip", () => {
    const s = clean();
    s.reservations[1] = { kind: 'PASSENGER', id: 'load-passenger-2', tripId: 't-active' };
    s.reservations[3] = { kind: 'DRIVER', id: 'load-driver-2', tripId: 't-active' };
    expect(evaluate(s)).toEqual([
      'reservation PASSENGER#load-passenger-2 points to trip t-active of load-passenger-1',
      'reservation DRIVER#load-driver-2 points to trip t-active of load-driver-1',
    ]);
  });

  it('2. a completed or rated trip without a billing record', () => {
    const s = clean();
    s.billed = new Set();
    expect(evaluate(s)).toEqual(['trip t-done is RATED but has no billing record']);
  });

  it('3. a driver ON_TRIP without an active trip', () => {
    const s = clean();
    s.drivers[1] = { id: 'load-driver-2', availability: 'ON_TRIP' };
    expect(evaluate(s)).toEqual(['driver load-driver-2 is ON_TRIP without an active trip']);
  });

  it('4. outbox events with a gap or not reaching the trip version', () => {
    const s = clean();
    s.eventVersions.set('t-done', [1, 2, 4, 5, 6]);
    s.eventVersions.set('t-active', [1]);
    expect(evaluate(s)).toEqual([
      'trip t-active has events [1] for version 2 (expected 1..2)',
      'trip t-done has events [1,2,4,5,6] for version 6 (expected 1..6)',
    ]);
  });

  it('5. a DLQ that grew during the run, and a queue that did not drain', () => {
    const s = clean();
    s.queues = [
      { name: 'billing', visible: 2, inFlight: 1, dlq: false },
      { name: 'billing-dlq', visible: 3, inFlight: 0, dlq: true },
    ];
    expect(evaluate(s)).toEqual(['queue billing did not drain: 2 visible, 1 in flight', 'DLQ billing-dlq has 2 new message(s) (3 now, 1 before the run)']);
  });
});

describe('exitCode', () => {
  it('fails on any violation, and on a run that read no trips (nothing checked is not a pass)', () => {
    expect(exitCode({ read: { trips: 3, drivers: 2, queues: 8 }, violations: [] })).toBe(0);
    expect(exitCode({ read: { trips: 3, drivers: 2, queues: 8 }, violations: ['x'] })).toBe(1);
    expect(exitCode({ read: { trips: 0, drivers: 2, queues: 8 }, violations: [] })).toBe(1);
    // Missing queue settings or drivers mean part of the check never ran.
    expect(exitCode({ read: { trips: 3, drivers: 2, queues: 0 }, violations: [] })).toBe(1);
    expect(exitCode({ read: { trips: 3, drivers: 0, queues: 8 }, violations: [] })).toBe(1);
  });
});

describe('queues on the Go path', () => {
  const env = {
    RIDECORE_DISPATCH_QUEUE_URL: 'q/d', RIDECORE_DISPATCH_DLQ_URL: 'q/d-dlq', RIDECORE_BILLING_QUEUE_URL: 'q/b', RIDECORE_BILLING_DLQ_URL: 'q/b-dlq',
    RIDECORE_DRIVER_OFFERS_QUEUE_URL: 'q/o', RIDECORE_DRIVER_OFFERS_DLQ_URL: 'q/o-dlq', RIDECORE_NOTIFICATIONS_QUEUE_URL: 'q/n', RIDECORE_NOTIFICATIONS_DLQ_URL: 'q/n-dlq',
    RIDECORE_LOCATION_TRIPS_QUEUE_URL: 'q/l', RIDECORE_LOCATION_TRIPS_DLQ_URL: 'q/l-dlq',
  };

  it('also reads the ridecore-location trip-assignments queue and its DLQ when LOCATION=1', () => {
    expect(queueUrls({ ...env, LOCATION: '1' }).map((q) => q.name)).toEqual(expect.arrayContaining(['location-trips', 'location-trips-dlq']));
    expect(requiredQueueCount({ LOCATION: '1' })).toBe(10);
  });

  it('reads the same 8 queues as before when the path is off', () => {
    expect(queueUrls(env).map((q) => q.name)).not.toContain('location-trips');
    expect(requiredQueueCount({})).toBe(8);
  });

  it('fails a Go-path check that read fewer than 10 queues', () => {
    expect(exitCode({ read: { trips: 3, drivers: 2, queues: 8 }, violations: [] }, 10)).toBe(1);
    expect(exitCode({ read: { trips: 3, drivers: 2, queues: 10 }, violations: [] }, 10)).toBe(0);
  });
});
