import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.ts';
import { toEvent } from '../domain/events.ts';
import { assertDistinct, estimateFare, validateLatLng } from '../domain/fare.ts';
import { type Actor, type LatLng, type Trip, transition } from '../domain/trip.ts';
import type { DriverRepo } from '../infra/dynamo/driver-repo.ts';
import { type ResultItem, resultItems } from '../infra/dynamo/transact.ts';
import type { OfferState, TripRepo } from '../infra/dynamo/trip-repo.ts';
import type { Dispatch } from './dispatch.ts';

export type TripDeps = { trips: TripRepo; drivers: DriverRepo; dispatch: Dispatch };

export type TripRef = { tripId: string };
export type RequestTripInput = { origin: LatLng; destination: LatLng };
export type CancelTripInput = TripRef & { reason?: string };
export type RateTripInput = TripRef & { score: number; comment?: string };
export type AdvanceAction = 'ARRIVE' | 'START' | 'COMPLETE';
/**
 * Optional extra item built from the resulting trip and written in the SAME transaction as the
 * change (the HTTP layer passes the Idempotency-Key completion here). Every mutating use case takes it.
 */
export type TripCommit = ResultItem<Trip>;

export interface TripService {
  /** A passenger requests a STANDARD trip; one active trip per passenger (409 ACTIVE_TRIP_EXISTS). */
  requestTrip(actor: Actor, input: RequestTripInput, now: Date, commit?: TripCommit): Promise<Trip>;
  /** Readable by the owner passenger, the assigned driver or a driver holding a pending offer; else 404. */
  getTrip(actor: Actor, input: TripRef, now: Date): Promise<Trip>;
  /** The passenger's trips, newest first. */
  listMyTrips(actor: Actor, input: Record<string, never>, now: Date): Promise<Trip[]>;
  /** Owner passenger or assigned driver; frees the driver and retires offers in the same transaction. */
  cancelTrip(actor: Actor, input: CancelTripInput, now: Date, commit?: TripCommit): Promise<Trip>;
  /** Owner passenger, once, within 24 h of completion. */
  rateTrip(actor: Actor, input: RateTripInput, now: Date, commit?: TripCommit): Promise<Trip>;
  /** An offered driver accepts (one transaction with the driver going ON_TRIP). */
  acceptTrip(actor: Actor, input: TripRef, now: Date, commit?: TripCommit): Promise<Trip>;
  /** Assigned driver: ARRIVE / START, or COMPLETE (frees the driver in the same transaction). */
  advanceTrip(action: AdvanceAction): (actor: Actor, input: TripRef, now: Date, commit?: TripCommit) => Promise<Trip>;
}

const TRIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tripNotFound = () => new DomainError('TRIP_NOT_FOUND', 404, 'Trip not found');

/**
 * Why a driver entitled to try (offered or assigned) cannot accept `trip`: another driver holds it
 * (409 TRIP_ALREADY_TAKEN), or the state machine rejects ACCEPT (409 INVALID_TRANSITION, e.g. cancelled
 * or already accepted by this driver). If neither applies the trip changed under us: 409 CONCURRENT_UPDATE.
 */
function lostAccept(trip: Trip, actor: Actor, now: Date): DomainError {
  if (trip.driverId !== undefined && trip.driverId !== actor.id) {
    return new DomainError('TRIP_ALREADY_TAKEN', 409, 'Another driver already accepted this trip');
  }
  try {
    transition(trip, { type: 'ACCEPT', driverId: actor.id }, actor, now);
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  return new DomainError('CONCURRENT_UPDATE', 409, 'The trip was modified concurrently');
}

/** Who may see a trip at all. Everyone else gets the same 404 as for a missing trip, so ids cannot be probed. */
function canSee(trip: Trip, offers: OfferState, actor: Actor): boolean {
  if (actor.role === 'passenger') return trip.passengerId === actor.id;
  if (trip.driverId !== undefined) return trip.driverId === actor.id;
  return trip.state === 'REQUESTED' && offers.driverIds.includes(actor.id);
}

export function createTripService(deps: TripDeps): TripService {
  const { trips, drivers, dispatch } = deps;

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
    commit: TripCommit | undefined,
  ): Promise<Trip> {
    const before = await visible(tripId, actor);
    const after = transition(before, typeof action === 'string' ? { type: action } : action, actor, now);
    await trips.save(before, after, toEvent(before, after), resultItems(commit, after));
    return after;
  }

  return {
    async requestTrip(actor, input, now, commit) {
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
      await trips.create(trip, toEvent(null, trip), resultItems(commit, trip));
      return trip;
    },

    getTrip(actor, input) {
      return visible(input.tripId, actor);
    },

    listMyTrips(actor) {
      return trips.history(actor.id);
    },

    async cancelTrip(actor, input, now, commit) {
      await visible(input.tripId, actor);
      return dispatch.finishTrip(
        input.tripId,
        input.reason === undefined ? { type: 'CANCEL' } : { type: 'CANCEL', reason: input.reason },
        actor,
        now,
        commit,
      );
    },

    rateTrip(actor, input, now, commit) {
      const rate = { type: 'RATE' as const, score: input.score, ...(input.comment === undefined ? {} : { comment: input.comment }) };
      return step(input.tripId, actor, rate, now, commit);
    },

    async acceptTrip(actor, input, now, commit) {
      if (!TRIP_ID.test(input.tripId)) throw tripNotFound();
      const found = await trips.getWithOffers(input.tripId);
      if (found === null) throw tripNotFound();
      const { trip, offers } = found;
      if (!canSee(trip, offers, actor)) {
        // Only a driver who held an offer (pending or retired) learns why; anyone else gets the 404 of a missing trip.
        if (actor.role !== 'driver' || !(await drivers.hasOffer(trip.id, actor.id))) throw tripNotFound();
        throw lostAccept(trip, actor, now);
      }
      if (trip.state !== 'REQUESTED') throw lostAccept(trip, actor, now);
      try {
        return await dispatch.acceptTrip(trip.id, actor, now, commit);
      } catch (err) {
        // The offer was there a moment ago: another driver won, or the passenger cancelled, in between.
        if (!(err instanceof DomainError && err.code === 'NOT_OFFERED')) throw err;
        throw lostAccept((await trips.get(trip.id)) ?? trip, actor, now);
      }
    },

    advanceTrip(action) {
      return async (actor, input, now, commit) => {
        if (action !== 'COMPLETE') return step(input.tripId, actor, action, now, commit);
        await visible(input.tripId, actor);
        return dispatch.finishTrip(input.tripId, { type: 'COMPLETE' }, actor, now, commit);
      };
    },
  };
}
