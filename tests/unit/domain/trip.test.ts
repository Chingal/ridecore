import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../src/domain/errors.ts';
import { toEvent } from '../../../src/domain/events.ts';
import { isActive, transition } from '../../../src/domain/trip.ts';
import type { Actor, Trip, TripAction, TripState } from '../../../src/domain/trip.ts';

const passenger: Actor = { id: 'p1', role: 'passenger' };
const d1: Actor = { id: 'd1', role: 'driver' };
const d2: Actor = { id: 'd2', role: 'driver' };
const t0 = new Date('2026-11-09T10:00:00.000Z');

function makeTrip(state: TripState = 'REQUESTED', extra: Partial<Trip> = {}): Trip {
  const assigned = state !== 'REQUESTED' && state !== 'CANCELLED';
  return {
    id: 't1',
    passengerId: 'p1',
    ...(assigned ? { driverId: 'd1' } : {}),
    serviceType: 'STANDARD',
    origin: { lat: 2.44, lng: -76.6 },
    destination: { lat: 2.46, lng: -76.58 },
    state,
    fareEstimate: 12000,
    timestamps: { [state]: t0.toISOString() },
    version: 1,
    createdAt: t0.toISOString(),
    ...extra,
  };
}

function expectDomainError(fn: () => unknown, status: number, code?: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    const err = e as DomainError;
    expect(err.status).toBe(status);
    if (code) expect(err.code).toBe(code);
    return;
  }
  throw new Error('expected DomainError');
}

describe('happy path', () => {
  it('walks REQUESTED to RATED, bumping version 1 to 6', () => {
    let t = makeTrip();
    t = transition(t, { type: 'ACCEPT', driverId: 'd1' }, d1, t0);
    expect(t.state).toBe('ACCEPTED');
    expect(t.driverId).toBe('d1');
    t = transition(t, { type: 'ARRIVE' }, d1, t0);
    expect(t.state).toBe('DRIVER_ARRIVED');
    t = transition(t, { type: 'START' }, d1, t0);
    expect(t.state).toBe('IN_PROGRESS');
    t = transition(t, { type: 'COMPLETE' }, d1, t0);
    expect(t.state).toBe('COMPLETED');
    expect(t.finalFare).toBe(t.fareEstimate);
    t = transition(t, { type: 'RATE', score: 5, comment: 'great' }, passenger, t0);
    expect(t.state).toBe('RATED');
    expect(t.rating).toEqual({ score: 5, comment: 'great' });
    expect(t.version).toBe(6);
    expect(t.timestamps.RATED).toBe(t0.toISOString());
  });

  it('does not mutate the input trip and stamps the new state', () => {
    const before = makeTrip();
    const now = new Date('2026-11-09T10:05:00.000Z');
    const after = transition(before, { type: 'ACCEPT', driverId: 'd1' }, d1, now);
    expect(before.state).toBe('REQUESTED');
    expect(before.version).toBe(1);
    expect(after.timestamps.ACCEPTED).toBe(now.toISOString());
    expect(after.version).toBe(2);
  });
});

describe('actor rules', () => {
  const cases: Array<[TripState, TripAction]> = [
    ['REQUESTED', { type: 'ACCEPT', driverId: 'd1' }],
    ['ACCEPTED', { type: 'ARRIVE' }],
    ['DRIVER_ARRIVED', { type: 'START' }],
    ['IN_PROGRESS', { type: 'COMPLETE' }],
  ];
  it.each(cases)('passenger cannot %s -> 403', (state, action) => {
    expectDomainError(() => transition(makeTrip(state), action, passenger, t0), 403);
  });

  it('ACCEPT with a driverId that is not the actor -> 403', () => {
    expectDomainError(() => transition(makeTrip(), { type: 'ACCEPT', driverId: 'd2' }, d1, t0), 403);
  });

  it('ARRIVE by a driver other than the assigned one -> 404', () => {
    expectDomainError(() => transition(makeTrip('ACCEPTED'), { type: 'ARRIVE' }, d2, t0), 404);
  });

  it('RATE by a driver -> 403', () => {
    const trip = makeTrip('COMPLETED', { finalFare: 12000 });
    expectDomainError(() => transition(trip, { type: 'RATE', score: 5 }, d1, t0), 403);
  });

  it('RATE by another passenger -> 404', () => {
    const trip = makeTrip('COMPLETED', { finalFare: 12000 });
    const other: Actor = { id: 'p2', role: 'passenger' };
    expectDomainError(() => transition(trip, { type: 'RATE', score: 5 }, other, t0), 404);
  });
});

describe('CANCEL', () => {
  it('passenger cancels from REQUESTED', () => {
    const t = transition(makeTrip(), { type: 'CANCEL', reason: 'changed mind' }, passenger, t0);
    expect(t.state).toBe('CANCELLED');
    expect(t.cancellation).toEqual({ by: 'passenger', reason: 'changed mind' });
    expect(t.version).toBe(2);
  });

  it('driver cannot cancel from REQUESTED -> 403', () => {
    expectDomainError(() => transition(makeTrip(), { type: 'CANCEL' }, d1, t0), 403);
  });

  it.each<TripState>(['ACCEPTED', 'DRIVER_ARRIVED'])('passenger or assigned driver cancels from %s', (state) => {
    const byP = transition(makeTrip(state), { type: 'CANCEL' }, passenger, t0);
    expect(byP.cancellation?.by).toBe('passenger');
    const byD = transition(makeTrip(state), { type: 'CANCEL' }, d1, t0);
    expect(byD.cancellation?.by).toBe('driver');
    expect(byD.state).toBe('CANCELLED');
  });

  it('a non-assigned driver cannot cancel -> 404', () => {
    expectDomainError(() => transition(makeTrip('ACCEPTED'), { type: 'CANCEL' }, d2, t0), 404);
  });

  it.each<TripState>(['IN_PROGRESS', 'COMPLETED', 'RATED', 'CANCELLED'])('CANCEL from %s -> 409', (state) => {
    expectDomainError(() => transition(makeTrip(state), { type: 'CANCEL' }, passenger, t0), 409, 'INVALID_TRANSITION');
  });
});

describe('invalid transitions', () => {
  const cases: Array<[TripState, TripAction, Actor]> = [
    ['REQUESTED', { type: 'START' }, d1],
    ['REQUESTED', { type: 'ARRIVE' }, d1],
    ['ACCEPTED', { type: 'COMPLETE' }, d1],
    ['ACCEPTED', { type: 'START' }, d1],
    ['ACCEPTED', { type: 'ACCEPT', driverId: 'd1' }, d1],
    ['DRIVER_ARRIVED', { type: 'COMPLETE' }, d1],
    ['IN_PROGRESS', { type: 'ARRIVE' }, d1],
    ['COMPLETED', { type: 'COMPLETE' }, d1],
    ['REQUESTED', { type: 'RATE', score: 5 }, passenger],
    ['IN_PROGRESS', { type: 'RATE', score: 5 }, passenger],
  ];
  it.each(cases)('%s + %j -> 409 INVALID_TRANSITION', (state, action, actor) => {
    expectDomainError(() => transition(makeTrip(state), action, actor, t0), 409, 'INVALID_TRANSITION');
  });
});

describe('RATE', () => {
  const completed = (): Trip => makeTrip('COMPLETED', { finalFare: 12000 });

  it.each([0, 6, 3.5, -1, Number.NaN])('score %s -> 400', (score) => {
    expectDomainError(() => transition(completed(), { type: 'RATE', score }, passenger, t0), 400);
  });

  it('exactly 24 h after completion is still allowed', () => {
    const now = new Date(t0.getTime() + 24 * 3600 * 1000);
    expect(transition(completed(), { type: 'RATE', score: 4 }, passenger, now).state).toBe('RATED');
  });

  it('more than 24 h after completion -> 422 RATING_WINDOW_CLOSED', () => {
    const now = new Date(t0.getTime() + 24 * 3600 * 1000 + 1);
    expectDomainError(() => transition(completed(), { type: 'RATE', score: 4 }, passenger, now), 422, 'RATING_WINDOW_CLOSED');
  });

  it('second rating on RATED -> 409', () => {
    const rated = transition(completed(), { type: 'RATE', score: 4 }, passenger, t0);
    expectDomainError(() => transition(rated, { type: 'RATE', score: 5 }, passenger, t0), 409);
  });
});

describe('isActive', () => {
  it('is true exactly for the four active states', () => {
    const all: TripState[] = ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'RATED', 'CANCELLED'];
    expect(all.filter(isActive)).toEqual(['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS']);
  });
});

describe('toEvent', () => {
  it('maps each transition to its event type and copies version', () => {
    const steps: Array<[TripAction, Actor, string]> = [
      [{ type: 'ACCEPT', driverId: 'd1' }, d1, 'trip.accepted'],
      [{ type: 'ARRIVE' }, d1, 'trip.driver_arrived'],
      [{ type: 'START' }, d1, 'trip.started'],
      [{ type: 'COMPLETE' }, d1, 'trip.completed'],
      [{ type: 'RATE', score: 5 }, passenger, 'trip.rated'],
    ];
    let t = makeTrip();
    const requested = toEvent(null, t);
    expect(requested.type).toBe('trip.requested');
    expect(requested.version).toBe(1);
    expect(requested.tripId).toBe('t1');
    for (const [action, actor, type] of steps) {
      const before = t;
      t = transition(before, action, actor, t0);
      const ev = toEvent(before, t);
      expect(ev.type).toBe(type);
      expect(ev.version).toBe(t.version);
      expect(ev.tripId).toBe('t1');
      expect(ev.occurredAt).toBe(t0.toISOString());
      expect(ev.eventId).toBeTruthy();
    }
  });

  it('maps cancel to trip.cancelled with the cancellation in the payload', () => {
    const before = makeTrip('ACCEPTED');
    const after = transition(before, { type: 'CANCEL', reason: 'x' }, d1, t0);
    const ev = toEvent(before, after);
    expect(ev.type).toBe('trip.cancelled');
    expect(ev.payload.cancellation).toEqual({ by: 'driver', reason: 'x' });
  });

  it('produces distinct eventIds per version', () => {
    const a = makeTrip();
    const b = transition(a, { type: 'ACCEPT', driverId: 'd1' }, d1, t0);
    expect(toEvent(a, b).eventId).not.toBe(toEvent(null, a).eventId);
  });
});
