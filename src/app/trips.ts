import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import { toEvent } from '../domain/events.ts';
import { assertDistinct, estimateFare, validateLatLng } from '../domain/fare.ts';
import { type Actor, type LatLng, type Trip, transition } from '../domain/trip.ts';
import type { OfferState, TripRepo } from '../infra/dynamo/trip-repo.ts';
import type { Dispatch } from './dispatch.ts';

export type TripDeps = { trips: TripRepo; dispatch: Dispatch };

export type TripRef = { tripId: string };
export type RequestTripInput = { origin: LatLng; destination: LatLng };
export type CancelTripInput = TripRef & { reason?: string };
export type RateTripInput = TripRef & { score: number; comment?: string };
export type AdvanceAction = 'ARRIVE' | 'START' | 'COMPLETE';

export interface TripService {
  /** A passenger requests a STANDARD trip; one active trip per passenger (409 ACTIVE_TRIP_EXISTS). */
  requestTrip(actor: Actor, input: RequestTripInput, now: Date): Promise<Trip>;
  /** Readable by the owner passenger, the assigned driver or a driver holding a pending offer; else 404. */
  getTrip(actor: Actor, input: TripRef, now: Date): Promise<Trip>;
  /** The passenger's trips, newest first. */
  listMyTrips(actor: Actor, input: Record<string, never>, now: Date): Promise<Trip[]>;
  /** Owner passenger or assigned driver; frees the driver and retires offers in the same transaction. */
  cancelTrip(actor: Actor, input: CancelTripInput, now: Date): Promise<Trip>;
  /** Owner passenger, once, within 24 h of completion. */
  rateTrip(actor: Actor, input: RateTripInput, now: Date): Promise<Trip>;
  /** An offered driver accepts (one transaction with the driver going ON_TRIP). */
  acceptTrip(actor: Actor, input: TripRef, now: Date): Promise<Trip>;
  /** Assigned driver: ARRIVE / START, or COMPLETE (frees the driver in the same transaction). */
  advanceTrip(action: AdvanceAction): (actor: Actor, input: TripRef, now: Date) => Promise<Trip>;
}

const TRIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tripNotFound = () => new DomainError('TRIP_NOT_FOUND', 404, 'Trip not found');

/** Who may see a trip at all. Everyone else gets the same 404 as for a missing trip, so ids cannot be probed. */
function canSee(trip: Trip, offers: OfferState, actor: Actor): boolean {
  if (actor.role === 'passenger') return trip.passengerId === actor.id;
  if (trip.driverId !== undefined) return trip.driverId === actor.id;
  return trip.state === 'REQUESTED' && offers.driverIds.includes(actor.id);
}

export function createTripService(deps: TripDeps): TripService {
  const { trips, dispatch } = deps;

  /**
   * Loads the trip only if `actor` may see it. Runs before the state machine because the domain's own
   * actor check would answer some strangers with 403 or 409 (a driver cancelling, or arriving at, a
   * REQUESTED trip they were never offered), which would reveal that the trip exists.
   */
  async function visible(tripId: string, actor: Actor): Promise<Trip> {
    if (!TRIP_ID.test(tripId)) throw tripNotFound();
    const found = await trips.getWithOffers(tripId);
    if (found === null || !canSee(found.trip, found.offers, actor)) throw tripNotFound();
    return found.trip;
  }

  /** A single-item transition: trip + outbox (+ reservation changes), guarded on the version read. */
  async function step(
    tripId: string,
    actor: Actor,
    action: 'ARRIVE' | 'START' | { type: 'RATE'; score: number; comment?: string },
    now: Date,
  ): Promise<Trip> {
    const before = await visible(tripId, actor);
    const after = transition(before, typeof action === 'string' ? { type: action } : action, actor, now);
    await trips.save(before, after, toEvent(before, after));
    return after;
  }

  return {
    async requestTrip(actor, input, now) {
      const origin = validateLatLng(input.origin);
      const destination = validateLatLng(input.destination);
      assertDistinct(origin, destination);
      const at = now.toISOString();
      const trip: Trip = {
        id: randomUUID(),
        passengerId: actor.id,
        serviceType: 'STANDARD',
        origin,
        destination,
        state: 'REQUESTED',
        fareEstimate: estimateFare(origin, destination),
        timestamps: { REQUESTED: at },
        version: 1,
        createdAt: at,
      };
      await trips.create(trip, toEvent(null, trip));
      return trip;
    },

    getTrip(actor, input) {
      return visible(input.tripId, actor);
    },

    listMyTrips(actor) {
      return trips.history(actor.id);
    },

    async cancelTrip(actor, input, now) {
      await visible(input.tripId, actor);
      return dispatch.finishTrip(
        input.tripId,
        input.reason === undefined ? { type: 'CANCEL' } : { type: 'CANCEL', reason: input.reason },
        actor,
        now,
      );
    },

    rateTrip(actor, input, now) {
      const rate = { type: 'RATE' as const, score: input.score, ...(input.comment === undefined ? {} : { comment: input.comment }) };
      return step(input.tripId, actor, rate, now);
    },

    async acceptTrip(actor, input, now) {
      // Strangers get 404 here and never reach dispatch, whose NOT_OFFERED would reveal the trip.
      const trip = await visible(input.tripId, actor);
      // The assigned driver retrying: the state machine answers 409 INVALID_TRANSITION.
      if (trip.state !== 'REQUESTED') transition(trip, { type: 'ACCEPT', driverId: actor.id }, actor, now);
      try {
        return await dispatch.acceptTrip(input.tripId, actor, now);
      } catch (err) {
        // The offer was visible a moment ago, so its disappearance means another driver won the race.
        if (err instanceof DomainError && err.code === 'NOT_OFFERED') {
          throw new DomainError('CONCURRENT_UPDATE', 409, 'The trip was taken by another driver');
        }
        throw err;
      }
    },

    advanceTrip(action) {
      return async (actor, input, now) => {
        if (action !== 'COMPLETE') return step(input.tripId, actor, action, now);
        await visible(input.tripId, actor);
        return dispatch.finishTrip(input.tripId, { type: 'COMPLETE' }, actor, now);
      };
    },
  };
}
